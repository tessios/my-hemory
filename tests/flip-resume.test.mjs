/* v1.5 — 백그라운드 복귀 뒤 센서 감시 재개
   iOS 는 앱 전환에서 devicemotion 이벤트를 쉬게 하지만 센서 권한은 페이지 단위로 유지된다.
   복귀 시 권한을 다시 묻지 않고 리스너만 다시 걸어야 한다.
   실행: node --test tests/flip-resume.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";

let permAsked = 0;
const listeners = new Map();
const fakeWindow = {
  DeviceMotionEvent: { requestPermission: async () => { permAsked++; return "granted"; } },
  DeviceOrientationEvent: { requestPermission: async () => { permAsked++; return "granted"; } },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  _count() { return [...listeners.values()].reduce((n, s) => n + s.size, 0); },
};
globalThis.window = fakeWindow;

const { FlipWatcher } = await import("../js/flip.js");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("복귀(resume): 권한을 다시 묻지 않고 리스너만 다시 건다", async () => {
  permAsked = 0;
  const w = new FlipWatcher({});
  w.perm = "granted";
  w.armed = true;
  w.start();
  assert.equal(fakeWindow._count(), 2, "devicemotion·deviceorientation 리스너");
  const before = w.listenAt;

  await tick(15);
  const r = w.resume();
  assert.equal(r.ok, true);
  assert.equal(r.restarted, true);
  assert.equal(permAsked, 0, "권한 창을 다시 띄우면 안 된다");
  assert.equal(w.perm, "granted", "권한 상태 유지");
  assert.equal(fakeWindow._count(), 2, "리스너는 정확히 한 벌만 남는다");
  assert.ok(w.listenAt > before, "watchdog 시각 갱신");

  // 다시 건 뒤에도 센서 값이 들어오면 신호 있음으로 바뀐다
  for (const fn of listeners.get("devicemotion")) {
    fn({ accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 } });
  }
  assert.equal(w.hasSignal, true);
  w.disable();
  assert.equal(fakeWindow._count(), 0);
});

test("복귀: 기능이 꺼져 있으면 감시를 켜지 않는다", () => {
  const w = new FlipWatcher({});
  w.perm = "granted";
  w.armed = false;
  const r = w.resume();
  assert.equal(r.ok, false);
  assert.equal(fakeWindow._count(), 0);
});

test("복귀: 차단된 권한은 건드리지 않는다", () => {
  const w = new FlipWatcher({});
  w.perm = "denied";
  w.armed = true;
  const r = w.resume();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "denied");
});

test("탭 재개(reanimate): 허용 상태면 프롬프트 없이 감시만 되살린다", async () => {
  permAsked = 0;
  const w = new FlipWatcher({});
  w.perm = "granted";
  w.armed = true;
  const ok = await w.reanimate();
  assert.equal(ok, true);
  assert.equal(permAsked, 0);
  w.disable();
});

test("탭 재개: 이번 로드에서 허용 전(unknown)이면 이 탭에서 한 번 묻는다", async () => {
  permAsked = 0;
  const w = new FlipWatcher({});
  w.perm = "unknown";
  w.armed = true;
  await w.reanimate();
  assert.ok(permAsked >= 1, "제스처 안에서 권한을 요청한다");
  w.disable();
});

test("복귀 직후 이벤트가 없으면 '탭해서 재개' 상태로 안내한다", async () => {
  const w = new FlipWatcher({});
  w.perm = "granted";
  w.armed = true;
  w.start();
  w.listenAt = Date.now() - 5000;     // 복귀 뒤 5초 동안 신호가 없다
  w.last.t = 0;
  w._sync();
  assert.equal(w.state, "nosignal");
  assert.match(w.label, /탭해서 재개/);
  w.disable();
});
