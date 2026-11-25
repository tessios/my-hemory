/* v1.5 — 앱을 떠났다 돌아올 때의 판단 로직 단위 테스트
   (마이크·센서를 '다시 묻지 않고' 이어 쓰는 규칙)
   실행: node --test tests/resume.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";

import { micResumePlan, afterUnmuteWait, sensorResumePlan, sensorQuietLabel, UNMUTE_WAIT_MS } from "../js/lifecycle.js";

test("micResumePlan: 대여 전이면 아무 것도 하지 않는다", () => {
  assert.equal(micResumePlan({ held: false, live: false, readyState: "none" }).action, "none");
});

test("micResumePlan: 살아 있는 트랙은 그대로 유지(다시 묻지 않음)", () => {
  const p = micResumePlan({ held: true, live: true, readyState: "live", muted: false });
  assert.equal(p.action, "keep");
  const pm = micResumePlan({ held: true, live: true, readyState: "live", muted: false }, { permission: "prompt" });
  assert.equal(pm.action, "keep", "권한 상태와 무관하게 살아 있으면 유지");
});

test("micResumePlan: muted 는 unmute 를 기다린다", () => {
  const p = micResumePlan({ held: true, live: false, readyState: "live", muted: true, state: "interrupted" });
  assert.equal(p.action, "wait-unmute");
});

test("micResumePlan: ended 는 권한이 허락된 경우에만 조용히 다시 연다", () => {
  assert.equal(micResumePlan({ held: true, live: false, readyState: "ended" }, { permission: "granted" }).action, "reopen");
  assert.equal(micResumePlan({ held: true, live: false, readyState: "ended" }, { permission: "unknown" }).action, "reopen");
  const g = micResumePlan({ held: true, live: false, readyState: "ended" }, { permission: "prompt" });
  assert.equal(g.action, "gesture", "권한 창이 뜰 수 있는 상태에서는 자동 호출하지 않는다");
});

test("micResumePlan: 차단됨은 제스처를 기다린다", () => {
  assert.equal(micResumePlan({ held: true, live: false, readyState: "ended", state: "denied" }).action, "gesture");
});

test("afterUnmuteWait: unmute 가 오면 그대로, 안 오면 새로 연다", () => {
  assert.equal(afterUnmuteWait({ live: true, muted: false, held: true }, { permission: "granted" }).action, "keep");
  assert.equal(afterUnmuteWait({ live: false, muted: true, held: true }, { permission: "granted" }).action, "reopen");
  assert.equal(afterUnmuteWait({ live: false, muted: true, held: true }, { permission: "prompt" }).action, "gesture");
  assert.equal(afterUnmuteWait({ live: false, muted: false, held: true }, { ended: true }).action, "reopen");
});

test("UNMUTE_WAIT_MS 는 짧되 복귀가 늦어 보이지 않게", () => {
  assert.ok(UNMUTE_WAIT_MS >= 500 && UNMUTE_WAIT_MS <= 2500);
});

test("sensorResumePlan: 허용된 센서는 복귀 시 리스너만 다시 건다", () => {
  assert.equal(sensorResumePlan({ perm: "granted", listening: false, armed: true }), "restart");
  assert.equal(sensorResumePlan({ perm: "granted", listening: true, armed: true, hasSignal: false, quietMs: 1500 }), "restart");
  assert.equal(sensorResumePlan({ perm: "granted", listening: true, armed: true, hasSignal: true, quietMs: 10 }), "none");
});

test("sensorResumePlan: 이번 로드에서 허용 전이면 탭이 필요하다", () => {
  assert.equal(sensorResumePlan({ perm: "unknown", listening: false, armed: true }), "need-tap");
  assert.equal(sensorResumePlan({ perm: "denied", listening: false, armed: true }), "none");
  assert.equal(sensorResumePlan({ perm: "not-required", listening: false, armed: true }), "restart");
});

test("sensorResumePlan: 기능이 꺼져 있거나 화면이 가려져 있으면 건드리지 않는다", () => {
  assert.equal(sensorResumePlan({ perm: "granted", listening: true, armed: false, probe: false }), "none");
  assert.equal(sensorResumePlan({ perm: "granted", listening: false, armed: true }, { visible: false }), "none");
});

test("sensorQuietLabel: 조용한 센서는 '탭해서 재개'로 안내", () => {
  assert.equal(sensorQuietLabel({ perm: "granted", listening: true, hasSignal: false, quietMs: 1200, armed: true }), "탭해서 센서 재개");
  assert.equal(sensorQuietLabel({ perm: "granted", listening: true, hasSignal: true, quietMs: 10, armed: true }), "");
  assert.equal(sensorQuietLabel({ perm: "denied", listening: true, hasSignal: false, quietMs: 5000, armed: true }), "센서 권한 차단됨");
});
