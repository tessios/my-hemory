/* 공통 유틸 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function pad(n, w = 2) { return String(n).padStart(w, "0"); }

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec}초`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}시간 ${mm}분` : `${h}시간`;
}

const WD = ["일", "월", "화", "수", "목", "금", "토"];
export function fmtDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
}
export function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtMonth(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
export function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function relDay(iso) {
  const d = new Date(iso), now = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  return "";
}

export function toast(msg, ms = 2200) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch {}
}

export function debounce(fn, ms = 140) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* 한국어 검색용 정규화: 소문자, 공백·문장부호 제거 */
export function norm(s = "") {
  return String(s).toLowerCase()
    .replace(/[.,!?·…"'“”‘’()[\]{}<>~`@#$%^&*_+=|\\/:;−–—]/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

/* 질의를 토큰 배열로 (조사 꼬리 제거) */
export function tokenize(q = "") {
  return String(q).toLowerCase().split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
    .map((t) => t.replace(/(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만|좀|뭐|무슨)$/u, "") || t)
    .filter((t) => t.length > 0);
}

export function uid(len = 6) {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const rnd = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) s += a[rnd[i] % a.length];
  return s;
}

export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function localSettings() {
  try { return JSON.parse(localStorage.getItem("hemory.settings") || "{}"); } catch { return {}; }
}
export function saveSettings(patch) {
  const next = { ...localSettings(), ...patch };
  localStorage.setItem("hemory.settings", JSON.stringify(next));
  return next;
}
