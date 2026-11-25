/* v1.5.1 — "타임라인에서 엎으면 녹음이 시작되지 않던" 문제와 앱 전환 복귀 회귀 테스트
   ① 앱을 새로 열어도 저장된 뒤집어 녹음 설정이 armed 로 복원된다
   ② 탭을 옮겨도(setProbe(false)) 센서 감시가 꺼지지 않는다
   ③ 조용한(제스처 없는) 권한 시도는 실패해도 '차단됨'으로 낙인찍지 않는다
   ④ 앱을 나갔다 돌아오면 '이어서 녹음' 판단이 맞다
   ⑤ 30분 교체에서 옛 녹음기의 늦은 조각이 새 구간 파일에 섞이지 않는다
   실행: node --test tests/v151.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── 가짜 브라우저 ─────────────────────────────────────────── */
let gumCalls = 0;
let permMode = "granted";       // granted | throw
const listeners = new Map();

class FakeTrack extends EventTarget {
  constructor() { super(); this.kind = "audio"; this.readyState = "live"; this.muted = false; this.enabled = true; this.label = "iPhone 마이크"; }
  stop() { if (this.readyState === "ended") return; this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
class FakeStream {
  constructor() { this.track = new FakeTrack(); }
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}
class FakeAnalyser {
  constructor() { this.fftSize = 512; this.frequencyBinCount = 256; this.smoothingTimeConstant = 0.2; }
  getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 128; }
}
class FakeAudioContext {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = { connect() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return new FakeAnalyser(); }
  createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
}
class FakeMediaRecorder {
  static isTypeSupported(t) { return t === "audio/mp4"; }
  constructor(stream) { this.stream = stream; this.state = "inactive"; this.ondataavailable = null; this.onstop = null; }
  start() {
    this.state = "recording";
    this._timer = setInterval(() => {
      if (this.state !== "recording") return;
      this.ondataavailable?.({ data: new Blob([new Uint8Array(256)], { type: "audio/mp4" }) });
    }, 5);
  }
  stop() {
    clearInterval(this._timer);
    const was = this.state;
    this.state = "inactive";
    if (was !== "recording") { queueMicrotask(() => this.onstop?.()); return; }
    this.ondataavailable?.({ data: new Blob([new Uint8Array(128)], { type: "audio/mp4" }) });
    queueMicrotask(() => this.onstop?.());
  }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
}

const fakeWindow = {
  DeviceMotionEvent: {
    requestPermission: async () => {
      if (permMode === "throw") { const e = new Error("gesture required"); e.name = "NotAllowedError"; throw e; }
      return "granted";
    },
  },
  DeviceOrientationEvent: {
    requestPermission: async () => {
      if (permMode === "throw") { const e = new Error("gesture required"); e.name = "NotAllowedError"; throw e; }
      return "granted";
    },
  },
  MediaRecorder: FakeMediaRecorder,
  AudioContext: FakeAudioContext,
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  _count() { return [...listeners.values()].reduce((n, s) => n + s.size, 0); },
};
const fakeDocument = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.AudioContext = FakeAudioContext;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: { async getUserMedia() { gumCalls++; return new FakeStream(); } },
    permissions: { query: async () => ({ state: "granted" }) },
  },
});

const { FlipWatcher } = await import("../js/flip.js");
const { Recorder, releaseMic } = await import("../js/record.js");
const { flipBootPlan, resumePlan, RESUME_GAP_MS } = await import("../js/flow.js");

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/* ① 앱 시작 시 복원 */
test("flipBootPlan: 저장된 설정이 켜져 있으면 armed 로 복원하고 조용히 권한을 시도한다", () => {
  const p = flipBootPlan({ pref: true, supported: true, granted: false, perm: "unknown", micLive: false });
  assert.equal(p.arm, true, "v1.5.0 버그: armed 가 복원되지 않았다");
  assert.equal(p.ask, "silent");
  assert.equal(p.warmMic, true);
});

test("flipBootPlan: 설정이 꺼져 있으면 아무 것도 켜지 않는다", () => {
  const p = flipBootPlan({ pref: false, supported: true, granted: true, perm: "granted", micLive: true });
  assert.equal(p.arm, false);
  assert.equal(p.listen, false);
  assert.equal(p.ask, "none");
});

test("flipBootPlan: 이미 허용된 환경이면 바로 감시를 켠다", () => {
  const p = flipBootPlan({ pref: true, supported: true, granted: true, perm: "granted", micLive: true });
  assert.equal(p.arm, true);
  assert.equal(p.listen, true);
  assert.equal(p.ask, "none");
  assert.equal(p.warmMic, false);
});

test("flipBootPlan: 권한이 차단됐으면 armed 만 두고 묻지 않는다", () => {
  const p = flipBootPlan({ pref: true, supported: true, granted: false, perm: "denied", micLive: false });
  assert.equal(p.arm, true);
  assert.equal(p.listen, false);
  assert.equal(p.ask, "none");
});

/* ② 탭 이동이 감시를 끄지 않는다 */
test("armed 상태에서 setProbe(false)(탭 이동)는 센서 리스너를 끄지 않는다", () => {
  const w = new FlipWatcher({});
  w.setArmed(true);
  w.perm = "granted";
  w.start();
  assert.equal(w.listening, true);
  w.setProbe(false);                 // 타임라인·활동 탭으로 이동할 때 앱이 부르는 것
  assert.equal(w.listening, true, "설정을 켜 둔 채 탭을 옮겨도 감시는 유지돼야 한다");
  w.disable();
});

test("ensure(): 설정이 켜져 있는데 감시가 꺼졌으면 다시 건다", () => {
  const w = new FlipWatcher({});
  w.perm = "granted";
  w.setArmed(true);
  w._stopListening();
  assert.equal(w.listening, false);
  assert.equal(w.ensure(), true);
  assert.equal(w.listening, true);
  w.disable();
});

test("복원된 감시에서 폰을 엎으면 녹음이 시작된다(타임라인 시나리오)", async () => {
  const w = new FlipWatcher({ onStart: async () => true });
  const plan = flipBootPlan({ pref: true, supported: true, granted: false, perm: "unknown", micLive: true });
  w.setArmed(plan.arm);
  const r = await w.requestPermission({ silent: true });
  assert.equal(r.ok, true);
  w.setProbe(false);                 // 타임라인으로
  assert.equal(w.listening, true);

  w.last.gz = 9.8; w.last.beta = 180; w.last.t = Date.now();
  w.downSince = Date.now() - 1600;
  w.evaluate();
  await tick(30);
  assert.equal(w.active, true, "타임라인에서 엎으면 녹음이 시작돼야 한다");
  w.disable();
});

/* ③ 조용한 권한 시도 */
test("조용한 requestPermission 실패는 '차단됨'으로 낙인찍지 않는다", async () => {
  permMode = "throw";
  const w = new FlipWatcher({});
  const r = await w.requestPermission({ silent: true });
  permMode = "granted";
  assert.equal(r.ok, false);
  assert.equal(w.perm, "unknown", "제스처 없는 시도 실패는 차단이 아니다");
  assert.equal(w.granted, false);
});

test("제스처 안에서의 실패는 차단으로 기록한다(사용자가 실제로 거부한 경우)", async () => {
  permMode = "throw";
  const w = new FlipWatcher({});
  const r = await w.requestPermission();
  permMode = "granted";
  assert.equal(r.ok, false);
  assert.equal(w.perm, "denied");
});

/* ④ 이어서 녹음 판단 */
test("resumePlan: 마이크가 살아 있으면 터치 없이 이어서 녹음", () => {
  const p = resumePlan({ armed: true, gapMs: 5000, micLive: true, micMuted: false, perm: "granted" });
  assert.equal(p.action, "auto");
});

test("resumePlan: muted 트랙은 unmute 를 기다린 뒤 이어서 녹음한다(무음으로 시작하지 않는다)", () => {
  const p = resumePlan({ armed: true, gapMs: 5000, micLive: true, micMuted: true, perm: "granted" });
  assert.equal(p.action, "auto");
  assert.equal(p.reason, "wait-unmute");
});

test("resumePlan: 권한이 남아 있으면 조용히 다시 연다", () => {
  const p = resumePlan({ armed: true, gapMs: 5000, micLive: false, perm: "granted" });
  assert.equal(p.action, "auto");
});

test("resumePlan: 권한이 prompt 면 한 번 탭을 받는다", () => {
  const p = resumePlan({ armed: true, gapMs: 5000, micLive: false, perm: "prompt" });
  assert.equal(p.action, "gesture");
});

test("resumePlan: 오래 나갔으면 이어서 녹음을 끝낸다", () => {
  const p = resumePlan({ armed: true, gapMs: RESUME_GAP_MS + 1, micLive: true, perm: "granted" });
  assert.equal(p.action, "expire");
});

test("resumePlan: 대기 상태가 아니면 아무 것도 하지 않는다", () => {
  assert.equal(resumePlan({ armed: false, micLive: true }).action, "none");
  assert.equal(resumePlan({ armed: true, gapMs: 1000, visible: false }).action, "wait");
});

/* ⑤ 30분 교체 청크 분리 */
test("rotate: 옛 녹음기의 늦은 조각이 새 구간 파일에 섞이지 않는다", async () => {
  gumCalls = 0;
  releaseMic();
  const R = new Recorder();
  await R.start({ keepMic: true });
  await tick(30);
  const oldRec = R.rec;
  const seg1 = await R.rotate();
  assert.ok(seg1.blob.size > 0);

  // 교체 직후 도착한 옛 녹음기의 마지막 조각(실기기에서 흔히 늦게 온다)
  oldRec.ondataavailable?.({ data: new Blob([new Uint8Array(4096)], { type: "audio/mp4" }) });

  await tick(20);
  const seg2 = await R.rotate();
  assert.ok(seg2.blob.size > 0);
  assert.ok(seg2.blob.size < 4096, "옛 조각이 새 구간에 섞이면 m4a 가 깨진다");
  assert.equal(gumCalls, 1, "구간 교체는 마이크를 다시 열지 않는다");
  await R.stop();
  releaseMic();
});
