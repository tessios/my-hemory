/* v1.6 — 전사 완료 자동 반영(자동 동기화) 단위·연결 테스트
   ① 대기 중인 기록 수(전사 대기 / 요약 누락)를 정확히 센다
   ② 조건(모드·화면·녹음·동기화 중)에 따라 자동 동기화 여부를 판단한다
       - 전사·요약 대기 중이면 20초, 아니면 30초
       - 앱으로 돌아오면(force) 8초만 지나도 즉시
   ③ 기록 지문으로 "실제로 바뀌었을 때만" 다시 그린다
   ④ js/app.js 가 화면 복귀·주기 타이머에 자동 동기화를 연결했는가
   실행: node --test tests/v160.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  awaitingTranscription, missingSummary, autoSyncInterval, autoSyncDue, recordSignature,
  AUTO_SYNC_MS, AUTO_SYNC_PENDING_MS, AUTO_SYNC_FORCE_GAP_MS, AUTO_SYNC_TICK_MS,
} from "../js/pure.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "js/app.js"), "utf8");

const done = (base, extra = {}) => ({
  id: base, base, status: "done", fileId: "f-" + base, modifiedTime: "2026-11-26T10:00:00Z",
  summary: { one_line: "요약" }, ...extra,
});
const pending = (base, extra = {}) => ({
  id: "p-" + base, base, status: "pending", fileId: null, audioId: "a-" + base,
  modifiedTime: "2026-11-26T10:00:00Z", summary: {}, ...extra,
});
const emptySummary = (base) => done(base, { summary: { one_line: "" }, title: "11월 26일 기록" });

test("awaitingTranscription: 전사 대기 기록 수", () => {
  assert.equal(awaitingTranscription([]), 0);
  assert.equal(awaitingTranscription([pending("a"), done("b"), pending("c")]), 2);
  assert.equal(awaitingTranscription(null), 0);
});

test("missingSummary: 전사는 됐지만 요약이 빈 기록 — 전사 대기는 빼고 센다", () => {
  assert.equal(missingSummary([done("a"), emptySummary("b"), pending("c")]), 1);
});

test("autoSyncInterval: 대기 중인 작업이 있으면 20초, 없으면 30초", () => {
  assert.equal(autoSyncInterval([done("a")]), AUTO_SYNC_MS);
  assert.equal(autoSyncInterval([pending("a"), done("b")]), AUTO_SYNC_PENDING_MS);
  assert.equal(autoSyncInterval([emptySummary("a")]), AUTO_SYNC_PENDING_MS);
  assert.ok(AUTO_SYNC_PENDING_MS < AUTO_SYNC_MS);
  assert.ok(AUTO_SYNC_TICK_MS < AUTO_SYNC_PENDING_MS);
});

test("autoSyncDue: 기본 조건(실사용 중·화면 보임·유휴)에서 주기마다 실행", () => {
  const base = { now: 100000, lastSync: 0, syncState: "idle", mode: "live", visibility: "visible", recording: false, records: [done("a")] };
  assert.equal(autoSyncDue({ ...base, now: AUTO_SYNC_MS - 1 }), false);
  assert.equal(autoSyncDue({ ...base, now: AUTO_SYNC_MS }), true);
  // 전사 대기 중이면 더 자주
  const withPending = { ...base, records: [pending("a")] };
  assert.equal(autoSyncDue({ ...withPending, now: AUTO_SYNC_PENDING_MS }), true);
  assert.equal(autoSyncDue({ ...withPending, now: AUTO_SYNC_PENDING_MS - 1 }), false);
});

test("autoSyncDue: 녹음 중·화면 가려짐·동기화 중·데모 모드에서는 하지 않는다", () => {
  const base = { now: 10 * AUTO_SYNC_MS, lastSync: 0, syncState: "idle", mode: "live", visibility: "visible", recording: false, records: [] };
  assert.equal(autoSyncDue(base), true);
  assert.equal(autoSyncDue({ ...base, recording: true }), false);
  assert.equal(autoSyncDue({ ...base, visibility: "hidden" }), false);
  assert.equal(autoSyncDue({ ...base, syncState: "syncing" }), false);
  assert.equal(autoSyncDue({ ...base, mode: "demo" }), false);
  assert.equal(autoSyncDue({ ...base, mode: null }), false);
});

test("autoSyncDue: 앱으로 돌아오면(force) 8초만 지나도 즉시, 너무 잦으면 건너뛴다", () => {
  const base = { now: 100000, lastSync: 100000 - AUTO_SYNC_FORCE_GAP_MS, syncState: "idle", mode: "live", visibility: "visible", recording: false, records: [] };
  assert.equal(autoSyncDue({ ...base, force: true }), true);
  assert.equal(autoSyncDue({ ...base, lastSync: 100000 - 1000, force: true }), false);
  // 녹음 중이면 force 라도 하지 않는다
  assert.equal(autoSyncDue({ ...base, recording: true, force: true }), false);
});

test("recordSignature: 같으면 같고, 제목·상태·수정시각이 바뀌면 달라진다", () => {
  const a = [done("x"), pending("y")];
  assert.equal(recordSignature(a), recordSignature([done("x"), pending("y")]));
  // 전사 대기 → 전사 완료
  assert.notEqual(recordSignature(a), recordSignature([done("x"), done("y")]));
  // 맥이 요약을 채워 modifiedTime 이 바뀐 경우
  assert.notEqual(recordSignature([done("x")]),
    recordSignature([done("x", { modifiedTime: "2026-11-26T10:05:00Z" })]));
  assert.equal(recordSignature([]), "");
});

test("app.js: 자동 동기화가 화면 복귀·포커스·주기 타이머에 연결돼 있다", () => {
  assert.match(appSrc, /import\s*\{[\s\S]*?autoSyncDue[\s\S]*?\}\s*from\s*"\.\/pure\.js"/);
  assert.match(appSrc, /function autoSyncNow\(/);
  // 주기 타이머
  assert.match(appSrc, /setInterval\(\(\) => autoSyncNow\(\), AUTO_SYNC_TICK_MS\)/);
  // 화면 복귀(visibilitychange) 안에서 즉시
  const vis = appSrc.slice(appSrc.indexOf('document.addEventListener("visibilitychange"'));
  assert.match(vis.slice(0, 1400), /autoSyncNow\(\{ force: true \}\)/);
  // 동기화는 조용히(auto) 돌 수 있고, 바뀐 게 없으면 다시 그리지 않는다
  assert.match(appSrc, /async function syncNow\(\{ manual = false, auto = false \} = \{\}\)/);
  assert.match(appSrc, /recordSignature\(S\.records\) !== beforeSig/);
});
