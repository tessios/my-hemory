/* v1.7.0 — "나갔다 들어와도 마이크 access 없이 자동 재연결" 회귀 테스트
   ─────────────────────────────────────────────────────────────
   실사용 요청: 앱을 나갔다 들어와도 '마이크 access' 를 다시 누르지 않게.
   이 파일이 지키는 것:
     ① 복귀·재실행 시 조용히 다시 잡아도 되는 경우와, 첫 탭을 기다려야 하는 경우의 구분
        (권한 granted / 이번 실행의 대여 끊김 / 예전 허용 / 아직 prompt / OS 차단)
     ② 마이크 열기는 앱 전체에서 한 번에 하나(getUserMedia 중복 호출 → 스트림 2개 방지)
     ③ 대기 중 레벨 표시가 '0'을 무음으로 오탐하지 않는다(컨텍스트 잠김 = 측정 대기)
     ④ 업로드 재전송 큐의 재시도 간격(실패할수록 늘어남)과 조건
     ⑤ 배포 파일의 버전·UI 배선(큐 배지·레벨 미터·복귀 경로)
   실행: node --test tests/v170.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoMicPlan, micGuide, meterVerdict, queueBackoff, queueDue,
  QUEUE_BASE_MS, QUEUE_MAX_MS,
} from "../js/lifecycle.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "js", "app.js"), "utf8");
const recordSrc = readFileSync(join(root, "js", "record.js"), "utf8");
const swSrc = readFileSync(join(root, "sw.js"), "utf8");
const indexSrc = readFileSync(join(root, "index.html"), "utf8");
const cssSrc = readFileSync(join(root, "app.css"), "utf8");
const configSrc = readFileSync(join(root, "js", "config.js"), "utf8");
const versionJson = JSON.parse(readFileSync(join(root, "version.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

/* ── ① 자동 재연결 판단 ─────────────────────────────────────── */

test("권한이 granted 면 대여가 없어도 탭 없이 연다", () => {
  assert.deepEqual(autoMicPlan({ permission: "granted" }).action, "open");
  assert.deepEqual(autoMicPlan({ permission: "granted", held: true }).action, "reopen");
});

test("이번 실행에서 열어 둔 대여가 끊겼으면 같은 권한으로 다시 연다", () => {
  const p = autoMicPlan({ permission: "unknown", held: true, live: false });
  assert.equal(p.action, "reopen");
  assert.equal(p.reason, "lease-lost");
});

test("아직 prompt 이고 허용한 적이 없으면 권한 창을 띄우지 않고 첫 탭을 기다린다", () => {
  const p = autoMicPlan({ permission: "prompt", everAllowed: false });
  assert.equal(p.action, "gesture");
  assert.equal(p.reason, "permission-prompt");
});

test("한 번 허용한 적이 있고 권한 상태를 알 수 없으면 조용히 시도한다", () => {
  assert.equal(autoMicPlan({ permission: "unknown", everAllowed: true }).action, "open");
});

test("OS 에서 차단됐으면 열지 않고 차단 상태를 알린다", () => {
  assert.equal(autoMicPlan({ permission: "denied", everAllowed: true }).action, "denied");
});

test("이미 살아 있으면 아무 것도 하지 않고, 녹음 중이면 건드리지 않는다", () => {
  assert.equal(autoMicPlan({ live: true, permission: "granted" }).action, "keep");
  assert.equal(autoMicPlan({ busy: true, permission: "granted" }).action, "skip");
});

test("안내는 진짜 막힌 경우에만 — 차단/다른 앱/예전 허용", () => {
  assert.match(micGuide({ permission: "denied" }), /설정/);
  assert.match(micGuide({ reason: "denied" }), /설정/);
  assert.match(micGuide({ reason: "NotReadableError" }), /다른 앱/);
  assert.match(micGuide({ reason: "NotAllowedError", everAllowed: true }), /탭/);
  assert.equal(micGuide({ reason: "NotAllowedError", everAllowed: false }), "");
});

/* ── ③ 레벨 표시가 0 을 무음으로 오탐하지 않는다 ─────────────── */

test("대여가 없으면 none", () => {
  assert.equal(meterVerdict({ hasStream: false }), "none");
});

test("컨텍스트가 잠겨 있으면 0 이어도 '측정 대기' — 무음이라고 적지 않는다", () => {
  assert.equal(meterVerdict({ hasStream: true, ctxRunning: false, rms: 0, zeroMs: 5000 }), "waiting");
  assert.equal(meterVerdict({ hasStream: true, ctxRunning: true, rms: null }), "waiting");
});

test("정확히 0 이 1초 넘게 이어지면 '신호 없음'", () => {
  assert.equal(meterVerdict({ hasStream: true, ctxRunning: true, rms: 0, zeroMs: 300 }), "live");
  assert.equal(meterVerdict({ hasStream: true, ctxRunning: true, rms: 0, zeroMs: 1200 }), "nosignal");
});

test("바닥 잡음 수준이 3초 이어지면 '무음'(조용한 방)", () => {
  assert.equal(meterVerdict({ hasStream: true, ctxRunning: true, rms: 0.002, floor: 0.002, quietMs: 3200 }), "silent");
  assert.equal(meterVerdict({ hasStream: true, ctxRunning: true, rms: 0.02, floor: 0.002, quietMs: 3200 }), "live");
});

test("끊긴 트랙은 interrupted / lost 로 구분한다", () => {
  assert.equal(meterVerdict({ hasStream: true, muted: true }), "interrupted");
  assert.equal(meterVerdict({ hasStream: true, ended: true }), "lost");
});

/* ── ④ 업로드 재전송 큐 ─────────────────────────────────────── */

test("재시도 간격은 실패할수록 늘고 최대 10분", () => {
  assert.equal(queueBackoff(0), QUEUE_BASE_MS);
  assert.equal(queueBackoff(1), QUEUE_BASE_MS * 2);
  assert.equal(queueBackoff(2), QUEUE_BASE_MS * 4);
  assert.ok(queueBackoff(20) <= QUEUE_MAX_MS);
  assert.equal(queueBackoff(20), QUEUE_MAX_MS);
});

test("큐가 비었거나 오프라인·화면 가려짐이면 보내지 않는다", () => {
  const now = 10_000_000;
  assert.equal(queueDue({ now, count: 0 }), false);
  assert.equal(queueDue({ now, count: 2, online: false }), false);
  assert.equal(queueDue({ now, count: 2, visible: false }), false);
});

test("큐 재시도 시각이 지나야 보낸다", () => {
  const now = 10_000_000;
  assert.equal(queueDue({ now, lastTry: now - 1000, count: 1, fails: 0 }), false);
  assert.equal(queueDue({ now, lastTry: now - QUEUE_BASE_MS, count: 1, fails: 0 }), true);
  assert.equal(queueDue({ now, lastTry: now - QUEUE_BASE_MS, count: 1, fails: 1 }), false);
  assert.equal(queueDue({ now, lastTry: now - QUEUE_BASE_MS * 2, count: 1, fails: 1 }), true);
});

/* ── ② 마이크 열기 단일화 (소스 수준) ─────────────────────────── */

test("record.js: 열기는 openMicShared 하나로만 진행한다", () => {
  assert.match(recordSrc, /function openMicShared/);
  assert.match(recordSrc, /if \(mic\.opening\) return mic\.opening/);
  assert.match(recordSrc, /openMicShared\(\{ stopOld: false \}\)/);
  // acquireMic 이 openMic 을 직접 부르면 중복 잠금이 되살아난다
  assert.doesNotMatch(recordSrc, /micPending = openMic\(\)/);
});

test("record.js: 허용 사실을 저장하고 자동 시도 근거로 쓴다", () => {
  assert.match(recordSrc, /hemory\.micAllowed/);
  assert.match(recordSrc, /markMicAllowed\(\)/);
  assert.match(recordSrc, /export function micEverAllowed/);
});

/* ── ⑤ 복귀 경로·UI 배선 ───────────────────────────────────── */

test("app.js: 복귀는 한 번만 처리하고, 대여가 없으면 조용히 다시 잡는다", () => {
  assert.match(appSrc, /function scheduleResume/);
  assert.match(appSrc, /silentMicReconnect\("resume"\)/);
  assert.match(appSrc, /silentMicReconnect\("boot"\)/);
  assert.match(appSrc, /autoMicPlan\(/);
  const vis = appSrc.slice(appSrc.indexOf('document.addEventListener("visibilitychange"'), appSrc.indexOf('document.addEventListener("visibilitychange"') + 900);
  assert.match(vis, /scheduleResume\(\)/);
  assert.doesNotMatch(vis, /resumeAfterBackground\(\)/, "visibilitychange 가 직접 복귀를 부르면 중복 실행된다");
});

test("app.js: 첫 터치에서도 자동 재획득(pointerdown 조용한 시도 + gesture 획득)", () => {
  assert.match(appSrc, /document\.addEventListener\("pointerdown", onDown, true\)/);
  assert.match(appSrc, /silentMicReconnect\("touch"\)/);
  assert.match(appSrc, /"pointerup", "touchend", "click", "keydown"/);
});

test("app.js: 예약 녹음과 이어서 녹음이 동시에 시작되지 않는다", () => {
  assert.match(appSrc, /busy: !recorderIdle\(\) \|\| S\.auto\.on \|\| S\.auto\.pending/);
});

test("UI: 업로드 대기 배지와 마이크 레벨 미터가 있고 스타일이 있다", () => {
  assert.match(indexSrc, /id="queue-dot"/);
  assert.match(indexSrc, /id="queue-n"/);
  assert.match(cssSrc, /\.qdot\{/);
  assert.match(appSrc, /function openQueueSheet/);
  assert.match(appSrc, /function paintMicMeter/);
  assert.match(cssSrc, /\.fc-meter\{/);
  assert.match(appSrc, /class="fc-meter"/);
});

test("버전은 v1.7.0 으로 일치한다", () => {
  assert.equal(versionJson.version, "1.7.0");
  assert.match(configSrc, /version: "1\.7\.0"/);
  assert.match(swSrc, /hemory-v1\.7\.0/);
  assert.match(indexSrc, /app\.css\?v=1\.7\.0/);
  assert.match(indexSrc, /js\/app\.js\?v=1\.7\.0/);
  assert.match(readme, /\*\*v1\.7\.0\*\*/);
});

/* ── ② 실제 모듈 동작 — getUserMedia 중복 호출·허용 기억 ─────────────────
   record.js 는 import 시점에 window/navigator 를 본다. 그래서 가짜 환경을 먼저
   깔고 동적 import 한다(이 파일의 다른 테스트는 순수 함수만 쓴다). */
let gumCalls = 0;
const streams = [];
class FakeTrack extends EventTarget {
  constructor() { super(); this.kind = "audio"; this.readyState = "live"; this.muted = false; this.enabled = true; this.label = "iPhone 마이크"; }
  stop() { if (this.readyState === "ended") return; this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
class FakeStream {
  constructor() { this.track = new FakeTrack(); }
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}
class FakeAnalyser {
  constructor() { this.fftSize = 1024; this.frequencyBinCount = 512; this.smoothingTimeConstant = 0.4; }
  getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 0; }
  getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 128; }
  connect() {} disconnect() {}
}
class FakeAudioContext {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = { connect() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return new FakeAnalyser(); }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
}
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = { AudioContext: FakeAudioContext, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia() { gumCalls++; await new Promise((r) => setTimeout(r, 5)); const s = new FakeStream(); streams.push(s); return s; },
    },
  },
});
const rec = await import("../js/record.js");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("마이크를 열면 '허용한 적 있음'을 기억한다 — 다음 실행의 자동 시도 근거", async () => {
  assert.equal(rec.micEverAllowed(), false);
  const r = await rec.acquireMic();
  assert.equal(r.ok, true);
  assert.equal(rec.micEverAllowed(), true);
  assert.equal(rec.micStatus().live, true);
  // 제스처로 AudioContext 를 깨우기 전에는 레벨을 '무음'이라 적지 않고 '측정 대기'로 둔다
  assert.equal(rec.micMeterRead().state, "waiting");
});

test("동시에 두 번 요청해도 getUserMedia 는 한 번만 나간다(스트림 2개 방지)", async () => {
  const before = gumCalls;
  const [a, b] = await Promise.all([rec.acquireMic(), rec.acquireMic()]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(gumCalls, before, "살아 있는 대여는 그대로 재사용한다");
  // 트랙이 끝난 뒤 동시에 다시 요청해도 새 스트림은 하나뿐
  rec.micTrack().end();
  await tick(5);
  const before2 = gumCalls;
  const [c, d] = await Promise.all([rec.acquireMic(), rec.resumeMicAfterBackground({ waitMs: 20 })]);
  assert.equal(c.ok, true);
  assert.ok(["reopened", "keep", "none"].includes(d.action), `예상 밖 동작: ${d.action}`);
  assert.equal(gumCalls, before2 + 1, "동시 복구에서도 새 스트림은 하나");
  assert.equal(rec.micStatus().live, true);
});

test("대여가 없으면 레벨은 none — 0 을 무음으로 내보이지 않는다", () => {
  rec.releaseMic();
  assert.equal(rec.micMeterRead().state, "none");
});
