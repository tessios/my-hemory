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

/* ── v1.5: 하루 타임라인 배치 ────────────────────────────────
   기록을 실제 시작 시각 순서로 놓고, 길이에 비례하는 높이를 준다.
   기록 사이의 빈 시간은 압축해(시간 눈금은 그 안에 비례 배치) 하루가 한 화면 흐름에 담기게 한다.
   반환: { height, blocks:[{id,top,height,startMin,endMin}], gaps:[{top,height,minutes}], ticks:[{min,top}] } */
export const FLOW = { minHeight: 132, pxPerMin: 1.5, gapMin: 8, gapPx: 18, gapMax: 96, lead: 26, tail: 34 };

export function minutesOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.getHours() * 60 + d.getMinutes();
}

export function hhmm(min) {
  const m = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function durationWords(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}시간 ${mm}분` : `${h}시간`;
}

/* 블록 머리글: "10:34 – 11:11 · 37분" (0초면 시작 시각만) */
export function blockRangeLabel(startIso, durationSec) {
  const start = minutesOf(startIso);
  if (start == null) return "";
  const dur = Math.max(0, Math.round(Number(durationSec) || 0));
  if (!dur) return hhmm(start);
  return `${hhmm(start)} – ${hhmm(start + Math.round(dur / 60))} · ${durationWords(dur)}`;
}

export function timelineFlow(items = [], opts = {}) {
  const o = { ...FLOW, ...opts };
  const list = (items || [])
    .map((it) => {
      const startMin = Number.isFinite(it.startMin) ? it.startMin : minutesOf(it.start);
      const rawEnd = Number.isFinite(it.endMin)
        ? it.endMin
        : startMin + Math.round(Number(it.durationSec || 0) / 60);
      return { id: it.id, startMin, endMin: Math.max((startMin ?? 0) + 1, rawEnd || (startMin ?? 0) + 1) };
    })
    .filter((it) => it.startMin != null && Number.isFinite(it.startMin))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const blocks = [], gaps = [], ticks = [];
  if (!list.length) return { height: 0, blocks, gaps, ticks };

  const first = list[0];
  let y = o.lead;
  // 앞쪽 빈 시간: 첫 기록이 있는 정시 3시간 전부터 압축 표시(최대 200px)
  const leadFrom = Math.max(0, Math.floor(first.startMin / 60) * 60 - 180);
  const leadSpan = first.startMin - leadFrom;
  if (leadSpan >= 30) {
    const leadH = Math.min(200, Math.round((leadSpan / 60) * 20));
    for (let m = leadFrom; m < first.startMin; m += 60) {
      ticks.push({ min: m, top: o.lead + ((m - leadFrom) / leadSpan) * leadH });
    }
    y = o.lead + leadH;
  }

  let prev = null;
  for (const it of list) {
    if (prev) {
      const gapMin = Math.max(0, it.startMin - prev.endMin);
      const gapH = gapMin <= 0 ? o.gapMin : Math.min(o.gapMax, o.gapPx + gapMin * 0.7);
      const top = y;
      if (gapMin > 0) {
        // 빈 시간이 길어 압축되면 정시 눈금이 겹친다 → 눈금 간격이 20px 이상 되도록 건너뛴다
        const hours = [];
        for (let m = Math.ceil(prev.endMin / 60) * 60; m < it.startMin; m += 60) hours.push(m);
        const perHour = (gapH / Math.max(1, gapMin / 60));
        const step = perHour < 20 ? Math.max(1, Math.ceil(20 / Math.max(0.1, perHour))) : 1;
        hours.forEach((m, i) => {
          if (i % step) return;
          ticks.push({ min: m, top: top + ((m - prev.endMin) / gapMin) * gapH });
        });
      }
      gaps.push({ top, height: gapH, minutes: gapMin });
      y += gapH;
    }
    const h = Math.max(o.minHeight, Math.round((it.endMin - it.startMin) * o.pxPerMin));
    blocks.push({ ...it, top: y, height: h });
    y += h;
    prev = it;
  }

  // 뒤쪽: 마지막 기록이 끝난 뒤 정시 2개까지
  const lastH = Math.ceil(prev.endMin / 60) * 60;
  let ty = y;
  for (let k = 1; k <= 2; k++) {
    const m = lastH + k * 60;
    if (m >= 1440) break;
    ty += 20;
    ticks.push({ min: m, top: ty });
  }
  const height = Math.max(ty, y) + o.tail;
  return { height, blocks, gaps, ticks: ticks.sort((a, b) => a.top - b.top) };
}

/* 선택한 날을 끝으로 하는 7일(기본) — { key, dow, day, month } */
export function weekDays(anchorKey, count = 7) {
  const [yy, mm, dd] = String(anchorKey || "").split("-").map(Number);
  const anchor = new Date(yy, (mm || 1) - 1, dd || 1);
  if (isNaN(anchor)) return [];
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - i);
    out.push({
      key: dateKeyOf(d),
      dow: d.getDay(),
      day: d.getDate(),
      month: d.getMonth() + 1,
    });
  }
  return out;
}

export function dateKeyOf(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* 카테고리 워터마크 — 화면에 크게 깔리는 영문 표기 */
export const CATEGORY_WORD = {
  meeting: "MEETING", work: "WORK", meal: "MEAL", daily: "DAILY", study: "STUDY", etc: "ETC",
};

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

/* ── 자동 동기화 (v1.6) ────────────────────────────────────────────────
   맥 파이프라인이 상주 감시(15초)로 _inbox 를 전사·요약하기 때문에,
   앱이 가만히 있어도 "전사 대기" 항목이 곧 채워진다. 화면을 다시 열었을 때와
   타임라인을 보고 있는 동안 드라이브 변경분을 다시 읽어 자동으로 반영한다.
   (녹음 중·화면 가려짐·동기화 중에는 건드리지 않는다) */
export const AUTO_SYNC_MS = 30000;          // 타임라인을 보고 있을 때 확인 주기
export const AUTO_SYNC_PENDING_MS = 20000;  // 전사·요약 대기 항목이 있을 때
export const AUTO_SYNC_TICK_MS = 5000;      // 위 조건을 판단하는 주기
export const AUTO_SYNC_FORCE_GAP_MS = 8000; // 복귀 직후 즉시 동기화의 최소 간격

/* 아직 전사 JSON 이 없는(전사 대기) 기록 수 */
export function awaitingTranscription(records = []) {
  return (records || []).filter((r) => r && (r.status === "pending")).length;
}

/* 전사는 됐지만 요약·제목이 비어 있는 기록 수 (Gemini 장애로 전사만 저장된 경우) */
export function missingSummary(records = []) {
  return (records || []).filter((r) => {
    if (!r || r.status === "pending") return false;
    const s = r.summary || {};
    const one = String(s.one_line || "").trim();
    return !one;
  }).length;
}

/* 지금 확인해야 하는 주기(ms) — 대기 중인 작업이 있으면 더 자주 */
export function autoSyncInterval(records = []) {
  return (awaitingTranscription(records) || missingSummary(records)) ? AUTO_SYNC_PENDING_MS : AUTO_SYNC_MS;
}

/* 지금 드라이브를 다시 읽어도 되는가 */
export function autoSyncDue({
  now = 0, lastSync = 0, syncState = "idle", mode = "", visibility = "visible",
  recording = false, records = [], force = false, intervalMs = null,
} = {}) {
  if (mode !== "live") return false;
  if (visibility !== "visible") return false;
  if (syncState === "syncing") return false;
  if (recording) return false;
  const gap = now - (lastSync || 0);
  if (force) return gap >= AUTO_SYNC_FORCE_GAP_MS;
  const iv = intervalMs == null ? autoSyncInterval(records) : intervalMs;
  return gap >= iv;
}

/* 기록 목록이 실제로 바뀌었는지 비교하는 지문 — 같으면 다시 그리지 않는다 */
export function recordSignature(records = []) {
  return (records || [])
    .map((r) => `${r.id || r.base || ""}|${r.modifiedTime || ""}|${r.status || ""}`)
    .sort()
    .join(",");
}

/* ── 예약 슬롯 (v1.6.2) ───────────────────────────────────────────────
   "사용자가 이 예약 시간대에서 직접 껐다"를 기억하려면 '어느 슬롯인지'가 필요하다.
   슬롯 = 창이 시작된 날짜 + 시작·끝 시각. 자정을 넘기는 구간(22:00~06:00)은
   00시~끝 시각대가 전날 시작한 창에 속하므로 시작 날짜를 하루 앞으로 잡는다.
   until 은 그 창이 끝나는 절대 시각(ms)이다. */
export function scheduleSlotOf(now = new Date(), d = null) {
  if (!d || !d.on) return null;
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
    if (!m) return null;
    const h = Number(m[1]), mm = Number(m[2]);
    if (h > 24 || mm > 59) return null;
    return (h % 24) * 60 + mm;
  };
  const a = toMin(d.start), b = toMin(d.end);
  if (a == null || b == null || a === b) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  const crosses = a > b;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  if (crosses && cur < b) start.setDate(start.getDate() - 1);
  let until = start.getTime() + b * 60000;
  while (until <= now.getTime()) until += 86400000;   // 자정을 넘겨 오늘 끝나는 창
  return { id: `${dateKeyOf(start)}|${d.start}|${d.end}`, start: start.getTime(), until, startMin: a, endMin: b };
}

/* 사용자가 껐던 슬롯인가 — 슬롯 id 가 같고 그 창이 아직 끝나지 않았을 때만 */
export function mutedAutoSlot(mute = null, slotId = "", now = Date.now()) {
  if (!mute || !mute.slot || !slotId) return false;
  if (mute.slot !== slotId) return false;
  return !(Number.isFinite(mute.until) && now >= mute.until);
}

/* 예약 녹음 재시도 간격(마이크가 막혔을 때) */
export const AUTO_RETRY_MS = 60000;

/* 예약 녹음 틱이 지금 해야 할 일: "start" | "stop" | null
   startAutoRecording/stopAutoRecording 을 직접 부르지 않고 이 판단만 테스트한다. */
export function nextAutoAction({
  active = false, slotId = "", now = Date.now(), on = false, pending = false,
  stopping = false, busy = false, failAt = 0, mute = null, retryMs = AUTO_RETRY_MS,
} = {}) {
  if (!active) return on ? "stop" : null;
  if (on || pending) return null;
  if (stopping) return null;
  if (mutedAutoSlot(mute, slotId, now)) return null;
  if (busy) return null;
  if (now - (failAt || 0) <= (retryMs || 0)) return null;
  return "start";
}
