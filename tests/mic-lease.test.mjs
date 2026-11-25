/* v1.4.1 — 마이크 대여(연결 유지) + 연속 엎기 통합 시뮬레이션
   iOS PWA 는 녹음이 끝나며 트랙을 stop() 하면 마이크 권한을 풀어, 다음(센서로 시작하는)
   녹음의 getUserMedia 가 사용자 터치 없이 막힌다. 그래서 스트림을 닫지 않고 재사용하는지,
   엎기→들기→다시 엎기를 여러 번 반복해도 getUserMedia 가 한 번만 불리는지 확인한다.
   실행: node --test tests/mic-lease.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── 가짜 브라우저 환경 ───────────────────────────────────── */
let gumCalls = 0;
let gumMode = "ok";              // ok | denied
const gumStreams = [];

class FakeTrack extends EventTarget {
  constructor() { super(); this.kind = "audio"; this.readyState = "live"; this.muted = false; this.enabled = true; this.label = "iPhone 마이크"; }
  stop() { if (this.readyState === "ended") return; this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
  interrupt() { this.muted = true; this.dispatchEvent(new Event("mute")); }
  restore() { this.muted = false; this.dispatchEvent(new Event("unmute")); }
}
class FakeStream {
  constructor() { this.track = new FakeTrack(); }
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}
class FakeAnalyser {
  constructor() { this.fftSize = 512; this.frequencyBinCount = 256; this.smoothingTimeConstant = 0.2; }
  getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 128 + ((i % 7) - 3); } // 아주 작은 신호
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
      // 실제 MediaRecorder 처럼 데이터 청크를 흘려보낸다
      const chunk = new Blob([new Uint8Array(256)], { type: "audio/mp4" });
      this.ondataavailable?.({ data: chunk });
    }, 5);
  }
  stop() {
    clearInterval(this._timer);
    const was = this.state;
    this.state = "inactive";
    if (was !== "recording") { queueMicrotask(() => this.onstop?.()); return; }
    // 마지막 조각 + onstop
    this.ondataavailable?.({ data: new Blob([new Uint8Array(128)], { type: "audio/mp4" }) });
    queueMicrotask(() => this.onstop?.());
  }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
}

/* window/document/이벤트 */
const listeners = new Map();
const fakeWindow = {
  DeviceMotionEvent: function DeviceMotionEvent() {},
  DeviceOrientationEvent: function DeviceOrientationEvent() {},
  MediaRecorder: FakeMediaRecorder,
  AudioContext: FakeAudioContext,
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
};
const fakeDocument = {
  visibilityState: "visible",
  _ls: new Map(),
  addEventListener(type, fn) {
    if (!this._ls.has(type)) this._ls.set(type, new Set());
    this._ls.get(type).add(fn);
  },
  removeEventListener(type, fn) { this._ls.get(type)?.delete(fn); },
};

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
        if (gumMode === "denied") {
          const e = new Error("Permission denied");
          e.name = "NotAllowedError";
          throw e;
        }
        const s = new FakeStream();
        gumStreams.push(s);
        return s;
      },
    },
  },
});

const { Recorder, acquireMic, releaseMic, micStatus, micTrack } = await import("../js/record.js");
const { FlipWatcher } = await import("../js/flip.js");

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test("acquireMic: 두 번째부터는 같은 스트림을 재사용한다", async () => {
  gumCalls = 0; gumMode = "ok";
  releaseMic();
  const a = await acquireMic();
  const b = await acquireMic();
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.reused, true);
  assert.equal(gumCalls, 1, "getUserMedia 는 한 번만 불려야 한다");
  assert.equal(a.stream, b.stream);
  assert.equal(micStatus().live, true);
});

test("Recorder: 녹음이 끝나도 마이크 트랙을 닫지 않는다(keepMic)", async () => {
  gumCalls = 0; gumMode = "ok";
  releaseMic();
  const R = new Recorder();
  const g1 = await R.start({ keepMic: true });
  void g1;
  await tick(30);
  const stream = micTrack();
  const out1 = await R.stop();
  assert.ok(out1.blob.size > 0, "첫 녹음 Blob 이 비면 안 된다");
  assert.equal(stream.readyState, "live", "녹음이 끝나도 트랙은 살아 있어야 한다");
  assert.equal(stream.muted, false);

  const out2 = await R.start({ keepMic: true }).then(() => tick(30)).then(() => R.stop());
  assert.ok(out2.blob.size > 0, "두 번째 녹음도 담겨야 한다");
  assert.equal(gumCalls, 1, "두 번째 녹음에서 getUserMedia 를 다시 부르면 안 된다");
  assert.equal(micTrack(), stream, "같은 스트림을 그대로 쓴다");
});

test("Recorder: keepMic=false 면 녹음 뒤 마이크를 닫는다(뒤집어 녹음 끈 상태)", async () => {
  gumCalls = 0; gumMode = "ok";
  releaseMic();
  const R = new Recorder();
  await R.start({ keepMic: false });
  await tick(20);
  await R.stop();
  assert.equal(micStatus().held, false);
  assert.equal(micTrack(), null);
});

test("30분 세그먼트 rotate: 새 스트림 없이 MediaRecorder 만 교체한다", async () => {
  gumCalls = 0; gumMode = "ok";
  releaseMic();
  const R = new Recorder();
  await R.start({ keepMic: true });
  await tick(30);
  const seg = await R.rotate();
  assert.ok(seg.blob.size > 0, "구간 Blob 이 담겨야 한다");
  assert.equal(gumCalls, 1, "구간 교체에서 getUserMedia 를 부르면 안 된다");
  await tick(30);
  const out = await R.stop();
  assert.ok(out.blob.size > 0);
  assert.equal(gumCalls, 1);
});

test("getUserMedia 거부: 코드가 붙은 오류로 알리고, 다음 호출은 다시 시도한다", async () => {
  gumCalls = 0;
  releaseMic();
  gumMode = "denied";
  const R = new Recorder();
  await assert.rejects(() => R.start({ keepMic: true }), (e) => {
    assert.equal(e.code, "denied");
    return true;
  });
  gumMode = "ok";
  await R.start({ keepMic: true });
  await tick(20);
  const out = await R.stop();
  assert.ok(out.blob.size > 0);
});

test("통합: 엎기→들기→다시 엎기 3회 — 재세팅 없이 매번 녹음되고 getUserMedia 는 1회", async () => {
  gumCalls = 0; gumMode = "ok";
  releaseMic();
  const R = new Recorder();
  const saved = [];
  const flip = new FlipWatcher({
    onStart: async () => {
      try {
        await R.start({ keepMic: true });
      } catch {
        return false;
      }
      return true;
    },
    onStop: async () => {
      const out = await R.stop();
      if (out?.blob?.size) saved.push(out);
    },
  });
  flip.armed = true;
  flip.start();

  const pose = (gz) => { flip.last.gz = gz; flip.last.t = Date.now(); };
  const settle = () => tick(40);

  for (let round = 1; round <= 3; round++) {
    // 폰을 엎는다 → 1.5초 유지
    pose(9.8);
    flip.downSince = Date.now() - 1600;
    flip.evaluate();
    await settle();
    assert.equal(flip.active, true, `${round}회차: 엎으면 녹음이 시작돼야 한다`);
    assert.equal(R.state, "recording", `${round}회차: MediaRecorder 가 돌아야 한다`);
    await tick(30);                       // 청크가 쌓이게

    // 폰을 든다 → 0.6초 유지 → 자동 저장
    pose(-9.8);
    flip.upSince = Date.now() - 700;
    flip.evaluate();
    await settle();
    assert.equal(flip.active, false, `${round}회차: 들면 녹음이 끝나야 한다`);
    assert.equal(saved.length, round, `${round}회차: 녹음이 저장 목록에 쌓여야 한다`);
    assert.ok(saved[round - 1].blob.size > 0, `${round}회차: 빈 파일이면 안 된다`);
    assert.equal(micStatus().live, true, `${round}회차: 마이크는 계속 연결돼 있어야 한다`);
  }

  assert.equal(gumCalls, 1, "3회 엎기에서 마이크 세팅(getUserMedia)은 처음 1회뿐이어야 한다");
  assert.equal(micTrack().readyState, "live");
  flip.disable();
  releaseMic();
});

test("통합: 대기 중 트랙이 끊기면(mute) 다음 엎기에서 조용히 다시 연결된다", async () => {
  gumCalls = 0; gumMode = "ok";
  releaseMic();
  const R = new Recorder();
  await acquireMic();
  const t = micTrack();
  t.interrupt();                          // 전화·화면 잠금 등으로 iOS 가 끊은 상황
  await tick(5);
  assert.equal(micStatus().live, false);
  const g = await acquireMic();           // 감시 루프가 하는 일
  assert.equal(g.ok, true);
  assert.notEqual(micTrack(), t, "끊긴 트랙은 버리고 새로 연다");
  await R.start({ keepMic: true });
  await tick(20);
  const out = await R.stop();
  assert.ok(out.blob.size > 0);
  releaseMic();
});

test("뒤집어 녹음 기능을 끄면 마이크를 닫는다", async () => {
  gumCalls = 0; gumMode = "ok";
  releaseMic();
  await acquireMic();
  assert.equal(micStatus().live, true);
  releaseMic();
  assert.equal(micStatus().held, false);
  assert.equal(micStatus().state, "idle");
});
