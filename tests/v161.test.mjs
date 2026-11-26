/* v1.6.1 — "예약녹음이 자동으로 켜지는데 말한 구간이 안 잡힌다" 회귀 테스트
   ① vad 를 요청했지만 AudioContext 가 suspend(iOS 무제스처 시작)면 wantVad=true / vad=false,
      speechSec 는 0 으로 남고 speechReady=false (UI 는 "확인 중"으로 표시)
   ② 첫 제스처(또는 2초 재시도)로 컨텍스트가 살아나면 그 순간부터 측정을 시작한다
      — speechFromSec 에 측정 시작 시점이 남고, analyser 를 새로 만든다
   ③ stop() 결과에 vad/speechSec/speechFromSec 이 함께 온다
   ④ app.js 가 pointerdown·visibilitychange 에서 tryResumeAudio 를 부르고
      예약 바는 측정 전에 "확인 중"으로 표시한다
   실행: node --test tests/v161.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ── 가짜 브라우저 ─────────────────────────────────────────── */
let ctxMode = "suspended";      // suspended | running — resume() 이 부르면 running 이 된다(제스처)
let sampleValue = 200;          // 128 = 무음, 크면 발화

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
  getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = sampleValue; }
}
class FakeAudioContext {
  constructor() { this.state = ctxMode; this.currentTime = 0; this.destination = { connect() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return new FakeAnalyser(); }
  createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createBuffer() { return {}; }
  createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
  async resume() { if (ctxMode === "running") this.state = "running"; }
  async close() { this.state = "closed"; }
}
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor(stream) { this.stream = stream; this.state = "inactive"; this.ondataavailable = null; this.onstop = null; }
  start() { this.state = "recording"; this._t = setInterval(() => this.ondataavailable?.({ data: new Blob([new Uint8Array(64)]), type: "audio/mp4" }), 20); }
  stop() { clearInterval(this._t); this.state = "inactive"; queueMicrotask(() => this.onstop?.()); }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
}

const fakeWindow = {
  MediaRecorder: FakeMediaRecorder,
  AudioContext: FakeAudioContext,
  addEventListener() {}, removeEventListener() {},
};
const fakeDocument = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.AudioContext = FakeAudioContext;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: { async getUserMedia() { return new FakeStream(); } },
    permissions: { query: async () => ({ state: "granted" }) },
    wakeLock: undefined,
  },
});

const { Recorder, releaseMic } = await import("../js/record.js");
const appSrc = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "js/app.js"), "utf8");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("① 무제스처 시작: wantVad 는 살아 있고 vad·speechReady 는 꺼져 있다", async () => {
  ctxMode = "suspended";
  const R = new Recorder();
  await R.start({ vad: true, keepMic: true });
  assert.equal(R.state, "recording");
  assert.equal(R.wantVad, true, "측정을 원한다는 사실은 남아 있어야 한다");
  assert.equal(R.vad, false);
  assert.equal(R.speechReady, false);
  await tick(60);
  assert.equal(R.speechSec, 0, "잠긴 컨텍스트에서는 0초로 세지 않는다");
  assert.equal(R.maxRms, null, "레벨을 못 쟀으면 무음 판정도 하지 않는다");
  const out = await R.stop();
  assert.equal(out.vad, false);
  assert.equal(out.speechSec, null);
  assert.equal(out.speechFromSec, null);
  releaseMic();
});

test("② 첫 제스처로 컨텍스트가 살아나면 그때부터 말한 구간을 센다", async () => {
  ctxMode = "suspended";
  const R = new Recorder();
  await R.start({ vad: true, keepMic: true });
  await tick(50);
  assert.equal(R.speechReady, false);

  // 제스처 한 번 — iOS 가 resume 을 허용한다
  ctxMode = "running";
  const ok = R.tryResumeAudio();
  assert.equal(ok, true);
  assert.equal(R.vad, true, "살아난 뒤에는 측정이 켜져야 한다");
  assert.equal(R.speechReady, true);
  assert.ok(R.speechFromSec !== null && R.speechFromSec >= 0, "측정 시작 시점이 남는다");

  await tick(160);
  assert.ok(R.speechSec > 0, `발화가 있는데도 0초(${R.speechSec})`);

  const out = await R.stop();
  assert.equal(out.vad, true);
  assert.ok(out.speechSec > 0);
  assert.ok(out.speechFromSec >= 0);
  releaseMic();
});

test("③ 이미 살아 있는 컨텍스트(제스처로 시작)는 처음부터 측정한다", async () => {
  ctxMode = "running";
  const R = new Recorder();
  await R.start({ vad: true, keepMic: false });
  assert.equal(R.vad, true);
  assert.equal(R.speechReady, true);
  assert.equal(R.speechFromSec, 0);
  await tick(120);
  assert.ok(R.speechSec > 0);
  const out = await R.stop();
  assert.equal(out.vad, true);
  assert.ok(out.speechSec > 0);
  releaseMic();
});

test("④ app.js: 제스처·복귀에서 잠긴 오디오를 깨우고, 예약 바는 '확인 중'으로 표시한다", () => {
  assert.match(appSrc, /document\.addEventListener\("pointerdown", wakeRecorderAudio/);
  assert.match(appSrc, /R\.tryResumeAudio\?\.\(\)/);
  const vis = appSrc.slice(appSrc.indexOf('document.addEventListener("visibilitychange"'));
  assert.match(vis.slice(0, 1600), /wakeRecorderAudio\(\)/);
  assert.match(appSrc, /말한 구간 \$\{ready \? fmtClock\(speech\) : "확인 중"\}/);
  assert.match(appSrc, /말한 구간 확인 중/);
});
