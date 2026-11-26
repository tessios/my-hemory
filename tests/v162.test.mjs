/* v1.6.2 — "예약 녹음 [종료]를 눌러도 안 꺼진다" 회귀 테스트
   ─────────────────────────────────────────────────────────────
   원인은 셋이었다.
     ① 예약 바를 1초마다 innerHTML 로 통째로 다시 그려 종료 버튼 노드가 교체 →
        손가락이 닿는 순간 click 이 사라진다(눌러도 반응 없음)
     ② '사용자가 이 슬롯에서 직접 껐다'를 기억하는 상태가 없어, S.auto.on=false 가
        되는 즉시 20초 틱·화면 복귀(visibilitychange)에서 다시 자동 시작
     ③ 종료 저장이 예외/지연되면 S.auto.on=false 에 도달하지 못해 켜진 채 남는다

   ①은 소스 수준에서, ②③은 js/pure.js 로 옮긴 판단(scheduleSlotOf·mutedAutoSlot·
   nextAutoAction)을 시간 경계까지 직접 돌려서 확인한다.
   실행: node --test tests/v162.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scheduleSlotOf, mutedAutoSlot, nextAutoAction, dateKeyOf, AUTO_RETRY_MS,
} from "../js/pure.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "js", "app.js"), "utf8");
const css = readFileSync(join(root, "app.css"), "utf8");

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const day = (start, end, on = true) => ({ on, start, end });
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/* 앱의 inWindow 와 같은 규칙(자정 넘김 포함) */
const activeAt = (now, d) => {
  if (!d?.on) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(d.start), b = toMin(d.end);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
};

/* ── ① 슬롯 식별자 ─────────────────────────────────────────── */

test("슬롯: 보통 구간은 그 날짜 + 끝 시각", () => {
  const now = at(2026, 11, 26, 12, 30);          // 목요일 낮
  const s = scheduleSlotOf(now, day("09:00", "18:00"));
  assert.equal(s.id, `2026-11-26|09:00|18:00`);
  assert.equal(s.until, at(2026, 11, 26, 18).getTime());
  assert.equal(s.startMin, 540);
  assert.equal(s.endMin, 1080);
  assert.ok(s.until > now.getTime(), "끝 시각은 아직 오지 않았다");
});

test("슬롯: 자정을 넘기는 구간도 한 슬롯으로 묶인다 (22:00~06:00)", () => {
  const before = scheduleSlotOf(at(2026, 11, 26, 23, 30), day("22:00", "06:00"));
  const after = scheduleSlotOf(at(2026, 11, 27, 0, 30), day("22:00", "06:00"));
  assert.equal(before.id, after.id, "23:30 과 00:30 은 같은 슬롯이어야 한다");
  assert.equal(before.id, `2026-11-26|22:00|06:00`, "슬롯 날짜는 창이 '시작한' 날짜");
  assert.equal(before.until, at(2026, 11, 27, 6).getTime());
  assert.equal(after.until, at(2026, 11, 27, 6).getTime());
  // 다음 날 저녁은 다른 슬롯
  const next = scheduleSlotOf(at(2026, 11, 27, 23, 0), day("22:00", "06:00"));
  assert.equal(next.id, `2026-11-27|22:00|06:00`);
});

test("슬롯: 끝이 00:00 인 구간은 다음 자정까지", () => {
  const s = scheduleSlotOf(at(2026, 11, 26, 23, 10), day("22:00", "00:00"));
  assert.equal(s.until, at(2026, 11, 27, 0).getTime());
});

test("슬롯: 꺼진 요일·잘못된 시각은 슬롯이 없다", () => {
  assert.equal(scheduleSlotOf(at(2026, 11, 26, 12), day("09:00", "18:00", false)), null);
  assert.equal(scheduleSlotOf(at(2026, 11, 26, 12), null), null);
  assert.equal(scheduleSlotOf(at(2026, 11, 26, 12), day("09:00", "09:00")), null);
  assert.equal(scheduleSlotOf(at(2026, 11, 26, 12), day("9시", "18:00")), null);
});

/* ── ② 억제 판정 ─────────────────────────────────────────── */

test("억제: 같은 슬롯 + 끝나기 전에만 유효", () => {
  const now = at(2026, 11, 26, 12);
  const s = scheduleSlotOf(now, day("09:00", "18:00"));
  const mute = { slot: s.id, until: s.until, at: now.getTime() };
  assert.equal(mutedAutoSlot(mute, s.id, now.getTime()), true);
  assert.equal(mutedAutoSlot(mute, s.id, s.until - 1), true, "끝 1ms 전까지는 꺼 둔다");
  assert.equal(mutedAutoSlot(mute, s.id, s.until), false, "끝나는 순간 억제가 풀린다");
  assert.equal(mutedAutoSlot(mute, "2026-11-27|09:00|18:00", now.getTime()), false, "다음 날은 정상");
  assert.equal(mutedAutoSlot(null, s.id, now.getTime()), false);
  assert.equal(mutedAutoSlot(mute, "", now.getTime()), false);
});

/* ── ③ 틱 판단 (재시작 금지의 핵심) ───────────────────────── */

const tick = (now, d, state = {}) => nextAutoAction({
  active: activeAt(now, d), slotId: scheduleSlotOf(now, d)?.id || "", now: now.getTime(),
  mute: state.mute || null, on: !!state.on, pending: !!state.pending,
  stopping: !!state.stopping, busy: !!state.busy, failAt: state.failAt || 0,
});

test("종료 직후: 20초 틱·화면 복귀에서도 다시 켜지 않는다", () => {
  const d = day("09:00", "18:00");
  const stoppedAt = at(2026, 11, 26, 10, 15);
  const slot = scheduleSlotOf(stoppedAt, d);
  const mute = { slot: slot.id, until: slot.until, at: stoppedAt.getTime() };
  // 사용자가 [종료]를 누른 직후 (on=false, 억제됨)
  assert.equal(tick(stoppedAt, d, { mute }), null, "종료한 그 순간");
  // 20초마다 도는 틱을 10분간 — 하나도 start 가 나오면 안 된다
  let starts = 0;
  for (let t = stoppedAt.getTime(); t < stoppedAt.getTime() + 10 * 60000; t += 20000) {
    if (tick(new Date(t), d, { mute }) === "start") starts++;
  }
  assert.equal(starts, 0, "억제된 슬롯에서 자동 시작이 일어났다");
  // 화면 복귀(visibilitychange → schedTick)도 즉시 본다
  assert.equal(tick(at(2026, 11, 26, 10, 20), d, { mute }), null);
  // 슬롯 끝(18:00)에서도 'start' 가 아니라 아무 것도 하지 않는다(이미 꺼져 있음)
  assert.equal(tick(at(2026, 11, 26, 18), d, { mute }), null);
  // 다음 날 같은 시간대는 정상 시작
  const nextDay = at(2026, 11, 27, 9, 0);
  assert.equal(tick(nextDay, d, { mute }), "start");
});

test("억제가 없으면 예전처럼 슬롯 안에서 시작하고, 창이 끝나면 멈춘다", () => {
  const d = day("09:00", "18:00");
  assert.equal(tick(at(2026, 11, 26, 9, 0), d), "start");
  assert.equal(tick(at(2026, 11, 26, 17, 59), d), "start");
  assert.equal(tick(at(2026, 11, 26, 18, 0), d), null);
  assert.equal(tick(at(2026, 11, 26, 18, 0), d, { on: true }), "stop");
});

test("틱: 진행 중·중복·대기·마이크 재시도에서는 시작하지 않는다", () => {
  const d = day("09:00", "18:00");
  const now = at(2026, 11, 26, 12);
  assert.equal(tick(now, d, { on: true }), null, "이미 녹음 중");
  assert.equal(tick(now, d, { pending: true }), null, "시작 중");
  assert.equal(tick(now, d, { stopping: true }), null, "종료 처리 중(연타)");
  assert.equal(tick(now, d, { busy: true }), null, "다른 녹음(빠른·뒤집어)이 마이크를 쓰는 중");
  assert.equal(tick(now, d, { failAt: now.getTime() - 1000 }), null, "마이크 실패 직후");
  assert.equal(
    tick(now, d, { failAt: now.getTime() - (AUTO_RETRY_MS + 1000) }), "start",
    "재시도 간격이 지나면 다시 시도",
  );
});

test("틱: 자정을 넘긴 슬롯에서도 억제가 이어진다", () => {
  const d = day("22:00", "06:00");
  const stoppedAt = at(2026, 11, 26, 23, 40);
  const slot = scheduleSlotOf(stoppedAt, d);
  const mute = { slot: slot.id, until: slot.until, at: stoppedAt.getTime() };
  assert.equal(tick(at(2026, 11, 26, 23, 59), d, { mute }), null);
  assert.equal(tick(at(2026, 11, 27, 0, 1), d, { mute }), null, "자정을 넘겨도 같은 슬롯");
  assert.equal(tick(at(2026, 11, 27, 5, 59), d, { mute }), null);
  assert.equal(tick(at(2026, 11, 27, 6, 0), d, { mute }), null, "창이 끝나면 시작하지 않는다");
  assert.equal(tick(at(2026, 11, 27, 22, 0), d, { mute }), "start", "다음 슬롯은 정상");
});

test("설정 변경으로 억제를 지우면 같은 슬롯에서도 다시 시작한다", () => {
  const now = at(2026, 11, 26, 12);
  const oldDay = day("09:00", "18:00");
  const slot = scheduleSlotOf(now, oldDay);
  const mute = { slot: slot.id, until: slot.until, at: now.getTime() };
  assert.equal(tick(now, oldDay, { mute }), null);
  // 설정을 바꾸면 슬롯 id 가 달라지거나(시간 변경) 앱이 clearAutoMute 로 지운다
  assert.equal(tick(now, day("08:00", "18:00"), { mute }), "start", "시간 변경 → 다른 슬롯");
  assert.equal(tick(now, oldDay, { mute: null }), "start", "억제 해제");
});

/* ── ④ 소스 수준 확인(버튼 클릭이 살아 있는가) ───────────── */

test("예약 바는 매초 innerHTML 로 다시 그리지 않고, 클릭은 바에 위임한다", () => {
  const start = app.indexOf("function renderAutoBar()");
  const end = app.indexOf("function onAutoBarClick", start);
  assert.ok(start > 0 && end > start, "renderAutoBar 를 찾지 못했습니다");
  const body = app.slice(start, end);
  const writes = [...body.matchAll(/bar\.innerHTML\s*=/g)].length;
  assert.equal(writes, 2, "골격을 만들 때 1번 + 비울 때 1번");
  const guard = body.slice(body.indexOf("bar.dataset.mode !== mode"));
  const skeletonWrites = [...guard.slice(0, 900).matchAll(/bar\.innerHTML\s*=/g)].length;
  assert.equal(skeletonWrites, 1, "그리는 innerHTML 은 상태가 바뀔 때만");
  assert.match(body, /bar\.dataset\.mode !== mode/, "상태가 바뀔 때만 골격을 다시 만든다");
  assert.equal(body.includes('$("#ab-info", bar)'), true, "매초 바뀌는 것은 글자뿐이다");
  assert.equal(body.includes('addEventListener("click"'), false, "매 렌더마다 리스너를 붙이면 안 된다");
  assert.equal(app.includes('$("#auto-bar")?.addEventListener("click", onAutoBarClick)'), true, "위임 핸들러가 걸려야 한다");
  assert.equal(app.includes('e.target.closest(".ab-stop")'), true, "종료 버튼 처리");
  assert.equal(app.includes('e.target.closest(".ab-again")'), true, "다시 켜기 버튼 처리");
  assert.equal(app.includes('$("#ab-stop", bar).addEventListener'), false, "예전 per-render 바인딩이 남아 있다");
});

test("종료는 억제를 저장보다 먼저 걸고, 실패해도 꺼진 상태로 끝난다", () => {
  const start = app.indexOf("async function stopAutoRecording");
  const end = app.indexOf("function schedTick()", start);
  const body = app.slice(start, end);
  assert.ok(body.length > 200, "stopAutoRecording 본문을 찾지 못했습니다");
  const muteAt = body.indexOf("setAutoMute(");
  const awaitAt = body.indexOf("await S.recorder.stop()");
  assert.ok(muteAt > 0, "수동 종료는 억제를 걸어야 한다");
  assert.ok(awaitAt > 0, "recorder.stop 호출이 있어야 한다");
  assert.ok(muteAt < awaitAt, "억제는 await 보다 먼저 — 저장이 실패해도 재시작되면 안 된다");
  assert.match(body, /S\.auto\.stopping = true/);
  assert.match(body, /catch[\s\S]{0,200}finally/, "예외가 나도 finally 로 상태를 내린다");
  assert.match(body, /finally\s*\{[\s\S]*?S\.auto\.on = false/, "finally 에서 on=false");
  assert.match(body, /reason === "manual"/, "수동 종료만 억제한다(시간 종료는 억제하지 않음)");
});

test("시작·틱·설정·복귀 경로가 모두 억제를 존중한다", () => {
  assert.match(app, /nextAutoAction\(\{/, "schedTick 은 순수 판단을 쓴다");
  const sched = app.slice(app.indexOf("function schedTick()"), app.indexOf("function armGestureRetry"));
  assert.equal(sched.includes("nextAutoAction({"), true, "틱 판단은 nextAutoAction 하나로");
  assert.equal(sched.includes("mutedAutoSlot") || sched.includes("mute: autoMute()"), true, "억제 상태를 넘긴다");
  const startAuto = app.slice(app.indexOf("async function startAutoRecording"), app.indexOf("async function stopAutoRecording"));
  assert.match(startAuto, /mutedAutoSlot\(autoMute\(\)/, "startAutoRecording 도 억제를 확인한다");
  assert.match(startAuto, /S\.auto\.stopping/, "종료 처리 중에는 시작하지 않는다");
  assert.equal(
    (app.match(/clearAutoMute\(\)/g) || []).length >= 4, true,
    "예약 설정을 바꾸는 곳(스위치·요일·시간)에서 억제를 푼다",
  );
  assert.match(app, /S\.resume\.kind === "auto" && autoMutedNow\(\)/, "이어서 녹음 경로도 억제를 본다");
  assert.match(app, /S\.seg\.rotating/, "30분 회전 중 종료 경합을 기다린다");
  assert.match(app, /if \(S\.auto\.stopping \|\| S\.seg\.rotating\) return;/, "회전 중복 방지");
});

test("꺼 둔 상태를 보여 주는 바와 스타일이 있다", () => {
  assert.match(app, /이번 예약 녹음은 꺼 두었습니다/);
  assert.match(app, /다시 켜기/);
  assert.match(app, /async function resumeAutoSlot/);
  assert.match(css, /\.ab-again\{/, "다시 켜기 버튼 스타일");
  assert.match(css, /\.ab-dot\.muted\{/, "꺼 둔 상태 점 스타일");
});

/* 날짜 계산이 로컬 시간대에 기대는 부분을 명시 (한국 시간대 개발/CI 공통) */
test("슬롯 날짜는 로컬 달력 기준 dateKeyOf 와 같다", () => {
  const s = scheduleSlotOf(at(2026, 11, 26, 12), day("09:00", "18:00"));
  assert.ok(s.id.startsWith(dateKeyOf(at(2026, 11, 26, 12))));
});
