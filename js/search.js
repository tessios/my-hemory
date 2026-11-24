/* 검색 인덱스 — 전사 문장 + 요약 문장을 대상으로 즉시 키워드 검색 */
import { norm, tokenize, esc } from "./util.js";

const STOP = new Set(["그리고", "그러면", "그런데", "그래서", "그럼", "다음", "지금", "한번", "여기", "저기", "거기", "이런", "저런", "그런", "그때", "이때", "먼저", "다시", "좀", "네", "예", "합니다", "있습니다", "했습니다", "하는", "있는", "같은", "이거", "저거", "그거", "네네", "예예", "아니", "근데", "이제", "약간", "되게", "정도", "때문", "우리", "제가", "그게", "이게", "저게"]);

export function buildIndex(records = []) {
  const segs = [];
  for (const r of records) {
    const sum = r.summary || {};
    const push = (text, o) => {
      if (!text || !String(text).trim()) return;
      segs.push({ rid: r.id, rec: r, text: String(text), n: norm(text), ...o });
    };
    for (const s of r.segments || []) {
      push(s.text, { kind: "seg", i: s.i, t: s.start ?? null, speaker: s.speaker || null });
    }
    for (const b of sum.bullets || []) push(b, { kind: "summary", t: null });
    for (const d of sum.decisions || []) push(d, { kind: "decision", t: null });
    for (const a of sum.actions || []) {
      const line = [a.owner, a.task, a.due].filter(Boolean).join(" · ");
      push(line, { kind: "action", t: null });
    }
    if (sum.one_line) push(sum.one_line, { kind: "oneliner", t: null });
  }
  return { segs, records };
}

export function highlight(text, tokens) {
  const safe = esc(text);
  const ts = (tokens || []).filter((t) => t.length >= 1).sort((a, b) => b.length - a.length);
  if (!ts.length) return safe;
  const re = new RegExp("(" + ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  return safe.replace(re, "<mark>$1</mark>");
}

export function search(idx, query, { type = "all", limit = 80 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const tnorm = tokens.map((t) => norm(t)).filter(Boolean);
  const out = [];
  for (const s of idx.segs) {
    if (type !== "all" && s.rec.type !== type) continue;
    let hits = 0, covered = 0;
    for (const t of tnorm) {
      if (!t) continue;
      const c = countOcc(s.n, t);
      if (c) { hits += c; covered++; }
    }
    if (!hits) continue;
    // 모든 토큰이 걸린 문장을 우선
    const score = hits * 2 + covered * 5 + (covered === tnorm.length ? 6 : 0)
      + (s.kind === "seg" ? 2 : 0) + (s.kind === "oneliner" ? 1 : 0);
    out.push({ ...s, score, hits, tokens });
  }
  out.sort((a, b) => b.score - a.score || new Date(b.rec.started_at) - new Date(a.rec.started_at));
  return dedupe(out).slice(0, limit);
}

function countOcc(hay, needle) {
  if (!needle || !hay) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const h of list) {
    const k = h.rid + ":" + h.n;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

/* AI 질문용 근거 묶음 */
export function evidence(idx, query, max = 12) {
  const hits = search(idx, query, { limit: max * 2 });
  const picked = [];
  const perRec = {};
  for (const h of hits) {
    perRec[h.rid] = perRec[h.rid] || 0;
    if (perRec[h.rid] >= 2) continue;
    perRec[h.rid]++;
    picked.push(h);
    if (picked.length >= max) break;
  }
  return picked;
}

export function keywords(idx, limit = 10) {
  const tf = new Map();
  for (const s of idx.segs) {
    if (s.kind !== "seg") continue;
    for (const w of s.text.split(/[\s,.!?·"'()\[\]{}~…]+/)) {
      const t = w.replace(/(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도)$/u, "").trim();
      if (t.length < 2 || STOP.has(t) || /^[0-9]+$/.test(t)) continue;
      tf.set(t, (tf.get(t) || 0) + 1);
    }
  }
  return [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}
