/* v1.5 — 백그라운드 전환 뒤 마이크 복구 통합 테스트
   앱을 떠났다 돌아왔을 때:
     · 살아 있는 트랙은 그대로 쓰고 getUserMedia 를 다시 부르지 않는다(권한 재요청 없음)
     · iOS 가 끊은(muted) 트랙은 unmute 를 기다렸다가 그대로 쓰고, 끝내 안 오면 새로 연다
     · ended 트랙은 새로 연다
     · 권한이 'prompt' 면 자동 호출하지 않고 제스처를 기다린다
   실행: node --test tests/resume-mic.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";

let gumCalls = 0;
let gumMode = "ok";
let gumThrowOnce = false;
const streams = [];

class FakeTrack extends EventTarget {
  constructor() { super(); this.kind = "audio"; this.readyState = "live"; this.muted = false; this.enabled = true; this.label = "iPhone 마이크"; }
  stop() { if (this.readyState === "ended") return; this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
  interrupt() { this.muted = true; this.dispatchEvent(new Event("mute")); }
  restore() { this.muted = false; this.dispatchEvent(new Event("unmute")); }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
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
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; queueMicrotask(() => this.onstop?.()); }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
}

let permissionState = null;   // null = 미지원(unknown)

const fakeWindow = {
  DeviceMotionEvent: function DeviceMotionEvent() {},
  DeviceOrientationEvent: function DeviceOrientationEvent() {},
  MediaRecorder: FakeMediaRecorder,
  AudioContext: FakeAudioContext,
  addEventListener() {},
  removeEventListener() {},
};
const fakeDocument = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.AudioContext = FakeAudioContext;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia() {
        gumCalls++;
        if (gumThrowOnce) { gumThrowOnce = false; const e = new Error("blocked"); e.name = "NotAllowedError"; throw e; }
        if (gumMode === "denied") { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; }
        const s = new FakeStream();
        streams.push(s);
        return s;
      },
    },
    get permissions() {
      if (permissionState == null) return undefined;
      return { query: async () => ({ state: permissionState }) };
    },
  },
});

const { acquireMic, releaseMic, micStatus, micTrack, resumeMicAfterBackground, markBackgrounded, unmuteWait } = await import("../js/record.js");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function reset() {
  gumCalls = 0; gumMode = "ok"; gumThrowOnce = false; permissionState = null;
  releaseMic();
}

test("백그라운드로 보내도 마이크를 닫지 않는다", async () => {
  reset();
  await acquireMic();
  const t = micTrack();
  markBackgrounded();
  assert.equal(micStatus().held, true, "떠날 때 스트림을 닫으면 안 된다");
  assert.equal(t.readyState, "live");
});

test("살아 있는 트랙으로 돌아오면 getUserMedia 를 다시 부르지 않는다", async () => {
  reset();
  await acquireMic();
  const t = micTrack();
  const r = await resumeMicAfterBackground({ waitMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.action, "keep");
  assert.equal(gumCalls, 1, "복귀 시에는 새로 열지 않는다");
  assert.equal(micTrack(), t);
});

test("ended 트랙은 조용히 새로 연다(같은 권한)", async () => {
  reset();
  permissionState = "granted";
  await acquireMic();
  const old = micTrack();
  old.end();
  await tick(5);
  const r = await resumeMicAfterBackground({ waitMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.action, "reopened");
  assert.equal(gumCalls, 2);
  assert.notEqual(micTrack(), old);
  assert.equal(micStatus().live, true);
});

test("muted 트랙은 unmute 를 기다렸다가 그대로 쓴다", async () => {
  reset();
  await acquireMic();
  const t = micTrack();
  t.interrupt();
  await tick(5);
  const p = resumeMicAfterBackground({ waitMs: 600 });
  setTimeout(() => t.restore(), 60);          // iOS 가 복귀 직후 unmute 하는 상황
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.action, "keep");
  assert.equal(r.reason, "unmuted");
  assert.equal(gumCalls, 1, "unmute 되면 새로 열지 않는다");
  assert.equal(micTrack(), t);
});

test("muted 가 풀리지 않으면 새로 연다", async () => {
  reset();
  permissionState = "granted";
  await acquireMic();
  const t = micTrack();
  t.interrupt();
  await tick(5);
  const r = await resumeMicAfterBackground({ waitMs: 60 });
  assert.equal(r.ok, true);
  assert.equal(r.action, "reopened");
  assert.equal(gumCalls, 2, "끊긴 트랙은 버리고 새로 연다");
  assert.notEqual(micTrack(), t);
});

test("권한이 'prompt' 면 자동으로 열지 않고 제스처를 기다린다", async () => {
  reset();
  permissionState = "prompt";
  await acquireMic();
  micTrack().end();
  await tick(5);
  const r = await resumeMicAfterBackground({ waitMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.action, "gesture");
  assert.equal(gumCalls, 1, "권한 창이 뜰 수 있는 상태에서는 getUserMedia 를 부르지 않는다");
});

test("대여가 없으면 복귀 때 아무 것도 하지 않는다", async () => {
  reset();
  const r = await resumeMicAfterBackground({ waitMs: 20 });
  assert.equal(r.action, "none");
  assert.equal(gumCalls, 0);
});

test("unmuteWait: 이미 살아 있으면 즉시 true, 끊긴 채면 시간 후 false", async () => {
  const t = new FakeTrack();
  assert.equal(await unmuteWait(t, 20), true);
  t.interrupt();
  const started = Date.now();
  assert.equal(await unmuteWait(t, 60), false);
  assert.ok(Date.now() - started >= 45);
});

test("재개 실패 뒤에도 옛 muted 트랙을 잃지 않는다", async () => {
  reset();
  permissionState = "granted";
  await acquireMic();
  const t = micTrack();
  t.interrupt();
  gumThrowOnce = true;
  const r = await resumeMicAfterBackground({ waitMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(micStatus().held, true, "새로 열지 못해도 대여는 유지된다");
  assert.equal(micTrack(), t);
});
