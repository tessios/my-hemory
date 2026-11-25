import { test } from "node:test";
import assert from "node:assert/strict";
import {
  previewLine, segmentRangeLabel, segmentDue, groupTranscript, audioMimeFor, silentVerdict, recordSegmentLabel,
} from "../js/pure.js";
import { judgePose } from "../js/flip.js";

test("previewLine: 요약 우선순위 one_line → bullets → 첫 문장 → 대기 문구", () => {
  assert.equal(previewLine({ summary: { one_line: "회의에서 일정 확정", bullets: ["무시"] } }), "회의에서 일정 확정");
  assert.equal(previewLine({ summary: { bullets: ["예산 3천 확정"] } }), "예산 3천 확정");
  assert.equal(previewLine({ segments: [{ text: "첫 문장입니다" }] }), "첫 문장입니다");
  assert.equal(previewLine({ status: "pending", summary: {} }), "맥에서 전사하면 요약이 표시됩니다");
  assert.equal(previewLine({ summary: {} }), "");
});

test("previewLine: 길면 잘라서 말줄임", () => {
  const long = "가".repeat(120);
  const out = previewLine({ summary: { one_line: long } }, { max: 40 });
  assert.equal(out.length, 40);
  assert.ok(out.endsWith("…"));
});

test("segmentRangeLabel: 시:분 표기", () => {
  const a = new Date(2026, 10, 25, 14, 0, 0).getTime();
  const b = new Date(2026, 10, 25, 14, 30, 0).getTime();
  assert.equal(segmentRangeLabel(a, b), "14:00~14:30");
});

test("segmentDue: 30분 경계", () => {
  const t0 = 1_000_000;
  assert.equal(segmentDue(t0, t0 + 1799_000), false);
  assert.equal(segmentDue(t0, t0 + 1800_000), true);
  assert.equal(segmentDue(0, Date.now()), false);
  assert.equal(segmentDue(t0, t0 + 5_000, 5), true);
});

test("groupTranscript: 30분 단위 블록으로 나뉜다", () => {
  const segs = [
    { start: 0, text: "a" }, { start: 60, text: "b" },
    { start: 1801, text: "c" }, { start: 3600, text: "d" },
    { start: 3599, text: "" },
  ];
  const blocks = groupTranscript(segs);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.segments.length), [2, 1, 1]);
  assert.equal(blocks[0].label, "0:00~30:00");
  assert.equal(blocks[1].label, "30:00~60:00");
  assert.equal(blocks[2].label, "60:00~90:00");
});

test("groupTranscript: 빈 입력", () => {
  assert.deepEqual(groupTranscript([]), []);
  assert.deepEqual(groupTranscript([{ start: 0, text: "   " }]), []);
});

test("audioMimeFor: 아이폰 재생용 MIME", () => {
  assert.equal(audioMimeFor("a.m4a"), "audio/mp4");
  assert.equal(audioMimeFor("a.MP4"), "audio/mp4");
  assert.equal(audioMimeFor("", "audio/mp4; charset=binary"), "audio/mp4");
  assert.equal(audioMimeFor("a.mp3"), "audio/mpeg");
  assert.equal(audioMimeFor("a.wav"), "audio/wav");
  assert.equal(audioMimeFor("a.webm"), "audio/webm");
  assert.equal(audioMimeFor("a.unknown", ""), "audio/mp4");
});

test("silentVerdict: 무음/정상 판정", () => {
  assert.deepEqual(silentVerdict({ durationSec: 0.4 }), { silent: true, reason: "too_short" });
  // VAD 켜짐: 말한 구간이 거의 없음
  assert.equal(silentVerdict({ maxRms: 0.5, durationSec: 60, speechSec: 0.1, vad: true }).silent, true);
  assert.equal(silentVerdict({ maxRms: 0.5, durationSec: 60, speechSec: 20, vad: true }).silent, false);
  // VAD 꺼짐: 레벨이 0에 가까움
  assert.equal(silentVerdict({ maxRms: 0.001, durationSec: 18 }).silent, true);
  assert.equal(silentVerdict({ maxRms: 0.08, durationSec: 18 }).silent, false);
});

test("silentVerdict: 레벨을 재지 못했으면(null) 무음이라고 단정하지 않는다", () => {
  assert.deepEqual(silentVerdict({ maxRms: null, durationSec: 40 }), { silent: false, reason: "unknown" });
  assert.deepEqual(silentVerdict({ maxRms: null, durationSec: 40, speechSec: 0, vad: true }), { silent: false, reason: "unknown" });
});

test("recordSegmentLabel: 메타 라벨/시각", () => {
  assert.equal(recordSegmentLabel({}), "");
  assert.equal(recordSegmentLabel({ segment: { label: "14:00~14:30" } }), "14:00~14:30");
  const start = new Date(2026, 10, 25, 9, 0).toISOString();
  const end = new Date(2026, 10, 25, 9, 30).toISOString();
  assert.equal(recordSegmentLabel({ segment: { start, end } }), "09:00~09:30");
});

test("judgePose: 엎임/위 판정", () => {
  // 아이폰 규약(zUp=-1): 화면이 위면 gz≈-9.8, 엎으면 gz≈+9.8
  assert.equal(judgePose({ gz: 9.8, beta: 175 }).pose, "down");
  assert.equal(judgePose({ gz: -9.8, beta: 5 }).pose, "up");
  assert.equal(judgePose({ gz: 0, beta: 90 }).pose, "tilt");
  assert.equal(judgePose({}).pose, "none");
});
