/* v1.5 — 하루 타임라인 배치·주간 바·블록 라벨 단위 테스트
   실행: node --test tests/timeline.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  timelineFlow, weekDays, dateKeyOf, blockRangeLabel, minutesOf, hhmm, durationWords, CATEGORY_WORD,
} from "../js/pure.js";

test("minutesOf: 로컬 시각을 분으로", () => {
  assert.equal(minutesOf("2026-11-25T10:34:00+09:00"), 10 * 60 + 34);
  assert.equal(minutesOf("bad"), null);
});

test("blockRangeLabel: 시작–종료 · 길이", () => {
  assert.equal(blockRangeLabel("2026-11-25T10:34:00+09:00", 37 * 60), "10:34 – 11:11 · 37분");
  assert.equal(blockRangeLabel("2026-11-25T13:38:00+09:00", 2 * 3600 + 9 * 60), "13:38 – 15:47 · 2시간 9분");
  assert.equal(blockRangeLabel("2026-11-25T09:05:00+09:00", 0), "09:05");
});

test("durationWords / hhmm", () => {
  assert.equal(durationWords(45), "45초");
  assert.equal(durationWords(3600), "1시간");
  assert.equal(hhmm(0), "00:00");
  assert.equal(hhmm(1440), "00:00");
  assert.equal(hhmm(13 * 60 + 8), "13:08");
});

test("timelineFlow: 빈 목록은 높이 0", () => {
  const f = timelineFlow([]);
  assert.equal(f.height, 0);
  assert.deepEqual(f.blocks, []);
});

test("timelineFlow: 하루 기록을 시간 순서로, 겹치지 않게 쌓는다", () => {
  const f = timelineFlow([
    { id: "b", startMin: 13 * 60 + 8, durationSec: 29 * 60 },
    { id: "a", startMin: 10 * 60 + 34, durationSec: 37 * 60 },
    { id: "c", startMin: 13 * 60 + 38, durationSec: 129 * 60 },
  ]);
  assert.deepEqual(f.blocks.map((b) => b.id), ["a", "b", "c"]);
  for (let i = 1; i < f.blocks.length; i++) {
    const prev = f.blocks[i - 1];
    assert.ok(f.blocks[i].top >= prev.top + prev.height, `${f.blocks[i].id} 가 이전 블록과 겹치면 안 된다`);
  }
  // 길이에 비례(긴 블록이 더 높다) + 최소 높이 보장
  assert.ok(f.blocks[2].height > f.blocks[1].height);
  assert.ok(f.blocks.every((b) => b.height >= 132));
  // 전체 높이는 마지막 블록 아래까지
  const last = f.blocks[f.blocks.length - 1];
  assert.ok(f.height > last.top + last.height);
});

test("timelineFlow: 빈 시간에는 정시 눈금이 압축되어 들어간다", () => {
  const f = timelineFlow([
    { id: "a", startMin: 10 * 60 + 34, durationSec: 37 * 60 },   // ~11:11
    { id: "b", startMin: 13 * 60 + 8, durationSec: 30 * 60 },    // 13:08~
  ]);
  const gap = f.gaps[0];
  assert.ok(gap && gap.minutes > 110, "블록 사이 빈 시간이 기록된다");
  const noon = f.ticks.find((t) => t.min === 12 * 60);
  assert.ok(noon, "12:00 눈금이 있다");
  assert.ok(noon.top >= gap.top && noon.top <= gap.top + gap.height, "12:00 은 빈 시간 안에 배치");
  const lead = f.ticks.find((t) => t.min === 9 * 60);
  assert.ok(lead && lead.top < f.blocks[0].top, "첫 블록 위쪽에도 정시 눈금이 있다");
  // 눈금은 위에서 아래로 정렬
  const tops = f.ticks.map((t) => t.top);
  assert.deepEqual(tops, [...tops].sort((a, b) => a - b));
});

test("timelineFlow: 같은 시각에 시작하는 기록도 순서대로 쌓인다(겹침 없음)", () => {
  const f = timelineFlow([
    { id: "a", startMin: 600, durationSec: 1800 },
    { id: "b", startMin: 600, durationSec: 600 },
  ]);
  assert.equal(f.blocks.length, 2);
  assert.ok(f.blocks[1].top >= f.blocks[0].top + f.blocks[0].height);
});

test("weekDays: 선택한 날을 끝으로 7일", () => {
  const w = weekDays("2026-11-25", 7);
  assert.equal(w.length, 7);
  assert.equal(w[0].key, "2026-11-19");
  assert.equal(w[6].key, "2026-11-25");
  assert.equal(w[6].dow, 3, "2026-11-25 는 수요일");
  assert.equal(w[0].dow, 4, "2026-11-19 는 목요일");
});

test("weekDays: 달을 넘어가도 이어진다", () => {
  const w = weekDays("2026-12-02", 7);
  assert.equal(w[0].key, "2026-11-26");
  assert.equal(w[6].key, "2026-12-02");
  assert.equal(dateKeyOf(new Date(2026, 0, 3)), "2026-01-03");
});

test("카테고리 워터마크 단어", () => {
  assert.equal(CATEGORY_WORD.meeting, "MEETING");
  assert.equal(CATEGORY_WORD.study, "STUDY");
  assert.equal(CATEGORY_WORD.etc, "ETC");
});

test("timelineFlow: 긴 빈 시간이 압축돼도 정시 눈금이 겹치지 않는다", () => {
  const f = timelineFlow([
    { id: "a", startMin: 9 * 60 + 16, durationSec: 60 },
    { id: "b", startMin: 19 * 60 + 54, durationSec: 46 * 60 },
  ]);
  const gapTicks = f.ticks.filter((t) => t.min > 9 * 60 + 17 && t.min < 19 * 60 + 54);
  assert.ok(gapTicks.length >= 3, `눈금이 남아 있다: ${gapTicks.length}`);
  for (let i = 1; i < gapTicks.length; i++) {
    assert.ok(gapTicks[i].top - gapTicks[i - 1].top >= 18, `눈금 간격 ${gapTicks[i].top - gapTicks[i - 1].top}px`);
  }
  assert.ok(gapTicks.length < 10, "10시간을 1시간 간격으로 다 넣지 않는다");
});
