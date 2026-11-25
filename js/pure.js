/* Hemory v1.4 — 순수 계산 모음 (DOM 없이 단위 테스트)
   타임라인 요약 미리보기, 30분 구간 계산, 전사 구간 묶기, 오디오 MIME 판정 등. */

export const SEGMENT_SEC = 1800; // 30분

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/* 타임라인 카드에 보여 줄 1~2줄 요약.
   우선순위: summary.one_line → summary.bullets[0] → 전사 첫 문장 → 상태 문구 */
export function previewLine(rec, { max = 90 } = {}) {
  if (!rec) return "";
  const sum = rec.summary || {};
  const one = (sum.one_line || "").trim();
  if (one) return clip(one, max);
  const b = Array.isArray(sum.bullets) ? (sum.bullets.find((x) => String(x || "").trim()) || "") : "";
  if (b) return clip(b, max);
  const first = (rec.segments || []).map((s) => String(s?.text || "").trim()).find(Boolean);
  if (first) return clip(first, max);
  if (rec.status === "pending") return "맥에서 전사하면 요약이 표시됩니다";
  return "";
}

/* "14:00~14:30" — 초 단위 두 시각을 30분 경계로 표시 */
export function segmentRangeLabel(startMs, endMs) {
  const f = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  return `${f(startMs)}~${f(endMs)}`;
}

/* 녹음 중 다음 30분 블록으로 넘어갈 시점인가 */
export function segmentDue(startedAtMs, nowMs = Date.now(), limitSec = SEGMENT_SEC) {
  if (!startedAtMs) return false;
  return nowMs - startedAtMs >= limitSec * 1000;
}

/* 전사를 30분 단위 블록으로 묶는다 (기존 긴 녹음 상세 표시용)
   blocks: [{ start: 0, end: 1800, label: "0:00–30:00", segments: [...] }] */
export function groupTranscript(segments = [], blockSec = SEGMENT_SEC) {
  const list = (segments || []).filter((s) => String(s?.text || "").trim());
  if (!list.length) return [];
  const blocks = [];
  for (const s of list) {
    const t = Number(s.start) || 0;
    const k = Math.floor(t / blockSec);
    let b = blocks[blocks.length - 1];
    if (!b || b.k !== k) {
      b = { k, start: k * blockSec, end: (k + 1) * blockSec, segments: [] };
      blocks.push(b);
    }
    b.segments.push(s);
  }
  for (const b of blocks) {
    const a = fmtClockShort(b.start), z = fmtClockShort(b.end);
    b.label = blockSec >= 1800 ? `${a}~${z}` : `${a}~${z}`;
  }
  return blocks;
}

function fmtClockShort(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/* 파일 이름/HTTP Content-Type 으로 재생용 MIME 결정 (iOS 는 audio/mp4 만 확실히 재생) */
export function audioMimeFor(name = "", contentType = "") {
  const n = String(name).toLowerCase();
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (/\.(m4a|mp4|aac)$/.test(n) || /mp4|aac/.test(ct)) return "audio/mp4";
  if (/\.mp3$/.test(n) || /mpeg/.test(ct)) return "audio/mpeg";
  if (/\.wav$/.test(n) || /wav/.test(ct)) return "audio/wav";
  if (/\.(ogg|opus)$/.test(n) || /ogg|opus/.test(ct)) return "audio/ogg";
  if (/\.webm$/.test(n) || /webm/.test(ct)) return "audio/webm";
  if (/\.caf$/.test(n) || /caf|x-caf/.test(ct)) return "audio/x-caf";
  return "audio/mp4";
}

/* 녹음이 사실상 무음이었는지 판정
   maxRms 가 null 이면 '레벨을 재지 못했다'는 뜻(AudioContext 가 잠들어 있음)이라
   무음이라고 단정하지 않는다 — 멀쩡한 녹음에 '무음' 딱지를 붙이지 않기 위해서다. */
export function silentVerdict({ maxRms = 0, durationSec = 0, speechSec = null, vad = false } = {}) {
  const dur = Number(durationSec) || 0;
  if (dur < 1) return { silent: true, reason: "too_short" };
  if (maxRms == null) return { silent: false, reason: "unknown" };
  const peak = Number(maxRms) || 0;
  if (vad && speechSec != null) {
    if (Number(speechSec) < Math.max(0.6, dur * 0.01)) return { silent: true, reason: "no_speech" };
    return { silent: false, reason: "ok" };
  }
  if (peak < 0.012) return { silent: true, reason: "no_signal" };
  return { silent: false, reason: "ok" };
}

/* 카드에 붙일 구간 표시 — segment 메타가 있으면 그 라벨, 없으면 빈 문자열 */
export function recordSegmentLabel(rec) {
  const seg = rec?.segment;
  if (!seg) return "";
  if (seg.label) return seg.label;
  if (seg.start && seg.end) {
    const a = Date.parse(seg.start), b = Date.parse(seg.end);
    if (Number.isFinite(a) && Number.isFinite(b)) return segmentRangeLabel(a, b);
  }
  return "";
}
