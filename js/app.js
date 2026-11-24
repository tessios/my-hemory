/* Hemory 개인용 — 앱 셸, 화면, 동기화, 재생 */
import { CONFIG, TYPES } from "./config.js";
import { drive, AuthError } from "./drive.js";
import { store } from "./store.js";
import { buildIndex, search as doSearch, evidence, keywords, highlight } from "./search.js";
import { ask as askGemini, transcribe as geminiTranscribe, hasGemini } from "./qa.js";
import { Recorder, pickAudioFile, extFor, mimeFor, probeDuration } from "./record.js";
import {
  $, $$, esc, fmtClock, fmtDuration, fmtDay, fmtTime, fmtMonth, dayKey, relDay,
  toast, haptic, debounce, uid, stamp, localSettings, saveSettings, sleep,
} from "./util.js";

const S = {
  mode: null,          // 'live' | 'demo'
  records: [],
  index: { segs: [], records: [] },
  filter: "all",
  tab: "timeline",
  searchMode: "search",
  query: "",
  syncState: "idle",
  lastSync: 0,
  player: null,
  recorder: new Recorder(),
  recordingSheet: null,
  sheet: null,
  auto: { on: false, pending: false, failAt: 0, startedAt: 0, type: "work", timer: null, gestureBound: false },
};

/* ── 예약 녹음(요일·시간) ─────────────────────────────── */
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function defaultSchedule() {
  const day = (on) => ({ on, start: on ? "09:00" : "10:00", end: on ? "18:00" : "18:00" });
  const days = {};
  for (const k of DAY_KEYS) days[k] = day(k !== "sun" && k !== "sat");
  return { enabled: false, type: "work", days };
}

function getSchedule() {
  const base = defaultSchedule();
  const saved = localSettings().schedule || {};
  const out = { enabled: !!saved.enabled, type: saved.type || base.type, days: { ...base.days } };
  for (const k of DAY_KEYS) {
    const d = saved.days?.[k];
    if (!d) continue;
    out.days[k] = {
      on: !!d.on,
      start: /^\d{1,2}:\d{2}$/.test(d.start || "") ? d.start : base.days[k].start,
      end: /^\d{1,2}:\d{2}$/.test(d.end || "") ? d.end : base.days[k].end,
    };
  }
  return out;
}

function saveSchedule(patch) {
  const next = { ...getSchedule(), ...patch };
  saveSettings({ schedule: next });
  return next;
}

function mins(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
}

/* 자정을 넘기는 구간(22:00~06:00)도 처리 */
function inWindow(now, d) {
  if (!d?.on) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = mins(d.start), b = mins(d.end);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

function scheduleActiveNow(now = new Date()) {
  const sch = getSchedule();
  if (!sch.enabled) return null;
  const d = sch.days[DAY_KEYS[now.getDay()]];
  return inWindow(now, d) ? d : null;
}

/* 녹음 상태가 바뀔 때마다 화면 조각들을 다시 그린다 */
const recListeners = new Set();
function recStatus() {
  for (const fn of recListeners) { try { fn(); } catch (e) { console.warn(e); } }
}
function addRecListener(fn) { recListeners.add(fn); return fn; }
function delRecListener(fn) { recListeners.delete(fn); }

/* ── 뒤집어서 자동 녹음(Face-Down) ───────────────────── */
const FACE = { beta: 145, up: 130, holdMs: 1500 };
S.face = { watcherOn: false, armed: false, downSince: 0, active: false, startedAt: 0, timer: null };

function faceDownPref() { return localSettings().faceDown === true; }

async function askMotionPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return false;
  if (typeof DOE.requestPermission === "function") {
    try { return (await DOE.requestPermission()) === "granted"; } catch { return false; }
  }
  return true;
}

function startFaceWatcher() {
  if (S.face.watcherOn || !window.DeviceOrientationEvent) return;
  S.face.watcherOn = true;
  window.addEventListener("deviceorientation", onOrient, true);
}

function stopFaceWatcher() {
  if (!S.face.watcherOn) return;
  S.face.watcherOn = false;
  S.face.downSince = 0;
  window.removeEventListener("deviceorientation", onOrient, true);
}

function armFacePermission() {
  if (S.face.armed) return;
  S.face.armed = true;
  const once = async () => {
    document.removeEventListener("pointerdown", once, true);
    document.removeEventListener("keydown", once, true);
    S.face.armed = false;
    if (!faceDownPref()) return;
    if (await askMotionPermission()) startFaceWatcher();
  };
  document.addEventListener("pointerdown", once, true);
  document.addEventListener("keydown", once, true);
}

function onOrient(e) {
  if (e.beta == null) return;
  const b = Math.abs(e.beta);
  const now = Date.now();
  if (b > FACE.beta) {
    if (!S.face.downSince) S.face.downSince = now;
    if (!S.face.active && !S.auto.on && S.recorder.state === "idle" && now - S.face.downSince >= FACE.holdMs) {
      startFaceRecording();
    }
  } else {
    S.face.downSince = 0;
    if (S.face.active && b < FACE.up) stopFaceRecording();
  }
}

async function startFaceRecording() {
  if (S.mode !== "live" || S.face.active) return;
  if (S.recorder.state !== "idle") return;
  try {
    await S.recorder.start({ vad: localSettings().vad !== false });
  } catch (e) {
    console.warn("face start", e);
    toast("엎어 녹음을 시작하려면 앱을 한 번 탭해 주세요");
    return;
  }
  S.face.active = true;
  S.face.startedAt = Date.now();
  haptic(16);
  showSleepOverlay();
  clearInterval(S.face.timer);
  S.face.timer = setInterval(updateSleepOverlay, 1000);
}

async function stopFaceRecording(save = true) {
  if (!S.face.active) return;
  S.face.active = false;
  clearInterval(S.face.timer);
  S.face.timer = null;
  hideSleepOverlay();
  const out = await S.recorder.stop();
  if (!save || !out || !out.blob?.size) return;
  const title = `뒤집어 녹음 ${fmtTime(new Date().toISOString())}`;
  try {
    await saveRecordingFast({ blob: out.blob, duration: out.duration, mime: out.mime, title, type: "work", speechSec: out.speechSec });
    haptic([10, 40, 10]);
    toast("녹음을 저장했습니다");
  } catch (e) {
    toast("기기에 보관했습니다 · 연결되면 올라갑니다");
  }
}

function showSleepOverlay() {
  const el = $("#sleep-overlay");
  if (!el) return;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  updateSleepOverlay();
}

function hideSleepOverlay() {
  const el = $("#sleep-overlay");
  if (!el) return;
  el.classList.remove("show");
  el.hidden = true;
}

function updateSleepOverlay() {
  const el = $("#sleep-overlay");
  if (!el || el.hidden) return;
  const t = $("#so-time", el);
  if (t) t.textContent = fmtClock((Date.now() - S.face.startedAt) / 1000);
}


/* ────────────────────────────────── 시작 ── */
async function boot() {
  drive.init();
  $("#app-version").textContent = CONFIG.version;
  let redirected = false;
  try { redirected = drive.consumeRedirect(); } catch {}

  bindGlobal();
  if (redirected && drive.signedIn) {
    enterLive();
    return;
  }
  if (drive.signedIn) {
    // 저장된 토큰이 살아 있으면 바로 시작하되, 실패하면 게이트로
    enterLive();
    return;
  }
  showScreen("gate");
  if (!drive.configured) $("#btn-signin").textContent = "처음 설정이 필요합니다";
}

function bindGlobal() {
  $("#btn-signin").addEventListener("click", async () => {
    if (!drive.configured) return openSetupSheet();
    try {
      setBtnLoading($("#btn-signin"), true);
      await drive.signIn({ interactive: true });
    } catch (e) {
      setBtnLoading($("#btn-signin"), false);
      if (e?.code === "no_client") return openSetupSheet();
      toast(e.message || "로그인하지 못했습니다.");
      return;
    }
    setBtnLoading($("#btn-signin"), false);
    if (drive.signedIn) enterLive();
  });
  $("#btn-demo").addEventListener("click", () => enterDemo());
  $("#btn-gate-setup").addEventListener("click", openSetupSheet);

  $$("#tabbar button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#btn-sync").addEventListener("click", () => syncNow({ manual: true }));
  $("#fab").addEventListener("click", openRecorder);

  // 검색
  $("#q").addEventListener("input", debounce((e) => { S.query = e.target.value; renderSearch(); }, 120));
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && S.searchMode === "ask") { e.preventDefault(); runAsk(); }
  });
  $("#q-clear").addEventListener("click", () => { $("#q").value = ""; S.query = ""; renderSearch(); $("#q").focus(); });
  $$("#search-mode button").forEach((b) => b.addEventListener("click", () => {
    S.searchMode = b.dataset.mode;
    $$("#search-mode button").forEach((x) => x.classList.toggle("on", x === b));
    $("#q").placeholder = S.searchMode === "ask" ? "기록에 물어보기 · 예: 지난 회의에서 결정된 것" : "기억나지 않는 말을 검색";
    renderSearch();
  }));

  window.addEventListener("online", () => { if (S.mode === "live") syncNow(); });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /* 녹음 상태 → 화면 조각들 */
  S.recorder.onStatus = recStatus;
  addRecListener(renderAutoBar);
  addRecListener(updateSleepOverlay);

  /* 화면이 가려지기 전까지 모인 소리는 잃지 않게 저장 */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") rescueRecording("hidden");
    else { schedTick(); renderAutoBar(); }
  });
  window.addEventListener("pagehide", () => { rescueRecording("pagehide"); });

  /* 절전 오버레이를 탭하면 바로 종료·저장 */
  $("#sleep-overlay")?.addEventListener("click", () => {
    if (S.face.active) stopFaceRecording(true);
  });

  /* 예열: 예약 녹음 20초마다 확인, 뒤집어 녹음은 첫 탭에서 동작 권한 */
  setInterval(schedTick, 20000);
  if (faceDownPref()) {
    startFaceWatcher();
    armFacePermission();
  }
}

function setBtnLoading(btn, on) {
  if (on) {
    btn._html = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn._html || "Google 계정으로 시작";
    btn.disabled = false;
  }
}

function showScreen(name) {
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + name));
  const chrome = name !== "gate";
  $("#tabbar").hidden = !chrome;
  $("#fab").hidden = !chrome || name !== "timeline";
}

function setTab(tab) {
  S.tab = tab;
  $$("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  showScreen(tab);
  $("#fab").hidden = tab !== "timeline";
  if (tab === "timeline") renderTimeline();
  if (tab === "search") { renderSearch(); setTimeout(() => $("#q").focus(), 120); }
  if (tab === "settings") renderSettings();
}

/* ────────────────────────────────── 모드 ── */
async function enterDemo() {
  S.mode = "demo";
  const res = await fetch("demo/demo-transcripts.json");
  const data = await res.json();
  S.records = data.recordings.map((r, i) => normalizeDemo(r, i));
  reindex();
  showChrome();
  setTab("timeline");
  applyDeepLink();
  toast("데모 데이터입니다 · 실제 저장은 되지 않습니다", 3000);
}

async function enterLive() {
  S.mode = "live";
  showChrome();
  drive.about().then((u) => {
    if (u.emailAddress) localStorage.setItem("hemory.email", u.emailAddress);
    if (S.tab === "settings") renderSettings();
  }).catch(() => {});
  const cached = await store.allRecords().catch(() => []);
  if (cached.length) {
    S.records = cached.sort(byRecent);
    reindex();
    renderTimeline();
  } else {
    $("#tl-list").innerHTML = '<div class="loading"><span class="spinner dark"></span></div>';
  }
  setTab("timeline");
  applyDeepLink();
  syncNow();
}

/* 매니페스트 바로가기(?tab=search, ?action=record) */
function applyDeepLink() {
  const p = new URLSearchParams(location.search);
  if (p.get("tab") === "search") setTab("search");
  if (p.get("action") === "record") setTimeout(openRecorder, 500);
}

function showChrome() {
  showScreen(S.tab || "timeline");
  $("#tabbar").hidden = false;
  $("#fab").hidden = false;
  $$("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === (S.tab || "timeline")));
}

const byRecent = (a, b) => new Date(b.started_at) - new Date(a.started_at);

function normalizeDemo(r, i) {
  let started = r.started_at;
  if (!started && r.day_offset != null) {
    const d = new Date();
    d.setDate(d.getDate() - Number(r.day_offset || 0));
    const [hh, mm] = String(r.time || "09:00").split(":");
    d.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0);
    started = d.toISOString();
  }
  if (!started) started = new Date(Date.now() - i * 86400000).toISOString();
  return {
    id: r.id || "demo-" + i,
    base: r.id || "demo-" + i,
    title: r.title,
    type: TYPES[r.type] ? r.type : "etc",
    started_at: started,
    duration_sec: r.duration_sec || 0,
    status: "done",
    summary: r.summary || {},
    speakers: r.speakers || [],
    segments: (r.segments || []).map((s, k) => ({ i: k, start: s.start, end: s.end, speaker: s.speaker, text: s.text })),
    source: "demo",
    fileId: null,
    audioId: null,
    demo: true,
  };
}

/* ────────────────────────────────── 동기화 ── */
async function syncNow({ manual = false } = {}) {
  if (S.mode !== "live" || S.syncState === "syncing") return;
  S.syncState = "syncing";
  $("#btn-sync").classList.add("spin");
  try {
    const { files } = await drive.listTree();
    const audioRe = /\.(m4a|mp3|wav|aac|caf|ogg|opus|webm)$/i;
    const audioByName = {};
    const jsons = [];
    for (const f of files) {
      const base = stripExt(f.name);
      if (/\.json$/i.test(f.name)) jsons.push({ ...f, base });
      else if (audioRe.test(f.name)) audioByName[base] = f;
    }

    const cached = new Map(S.records.filter((r) => r.fileId).map((r) => [r.fileId, r]));
    const next = [];
    const toFetch = jsons.filter((j) => cached.get(j.id)?.modifiedTime !== j.modifiedTime);

    const results = await mapLimit(toFetch, 4, async (j) => {
      try {
        const text = await drive.getText(j.id);
        const data = JSON.parse(text);
        return normalizeRecord(data, j, audioByName[j.base]);
      } catch (e) {
        console.warn("json parse fail", j.name, e);
        return null;
      }
    });

    for (const j of jsons) {
      const hit = results.find((r) => r && r.fileId === j.id);
      if (hit) next.push(hit);
      else if (cached.get(j.id)) next.push(cached.get(j.id));
    }

    // 전사 대기: 오디오만 있고 json 이 없는 파일
    const jsonBases = new Set(jsons.map((j) => j.base));
    for (const [base, a] of Object.entries(audioByName)) {
      if (jsonBases.has(base)) continue;
      next.push(pendingRecord(a, base));
    }

    S.records = next.sort(byRecent);
    reindex();
    await store.replaceAll(S.records.filter((r) => !r.demo)).catch(() => {});
    S.lastSync = Date.now();
    await store.setKV("lastSync", S.lastSync).catch(() => {});
    flushPending().catch(() => {});
    S.syncState = "idle";
    $("#btn-sync").classList.remove("spin");
    renderTimeline();
    if (S.tab === "search") renderSearch();
    if (manual) toast(`동기화 완료 · 기록 ${S.records.length}건`);
  } catch (e) {
    S.syncState = "idle";
    $("#btn-sync").classList.remove("spin");
    if (e instanceof AuthError) {
      toast(e.message);
      if (e.code === "expired") { showScreen("gate"); $("#tabbar").hidden = true; }
    } else {
      toast("동기화 실패: " + (e.message || "알 수 없는 오류"));
    }
    if (!S.records.length) renderTimeline();
  }
}

function stripExt(name = "") { return name.replace(/\.[a-z0-9]+$/i, ""); }

function normalizeRecord(data, fileMeta, audioMeta) {
  const started = data.started_at || data.created_at || guessTime(fileMeta.base) || fileMeta.createdTime;
  const segs = (data.segments || []).map((s, i) => ({
    i: Number.isFinite(s.i) ? s.i : i,
    start: Number(s.start) || 0,
    end: s.end != null ? Number(s.end) : null,
    speaker: s.speaker || s.spk || "",
    text: String(s.text || "").trim(),
  })).filter((s) => s.text);

  let summary = data.summary || {};
  if (!summary.one_line && data.one_line) summary = { ...summary, one_line: data.one_line };
  if (!summary.bullets && data.bullets) summary = { ...summary, bullets: data.bullets };
  if (!Array.isArray(summary.bullets)) summary.bullets = [];

  const dur = data.duration_sec || (segs.length ? Math.max(...segs.map((s) => s.end || s.start)) : 0);
  const m = (fileMeta.name || "").match(/^(\d{8})-(\d{4})_([a-z]+)_/i);

  return {
    id: data.id || fileMeta.base,
    base: fileMeta.base,
    title: data.title || defaultTitle(started, summary.one_line) || "제목 없는 기록",
    type: (data.type && TYPES[data.type]) ? data.type : (m && TYPES[m[3]] ? m[3] : "etc"),
    started_at: started,
    duration_sec: dur,
    status: data.status || (segs.length ? "done" : "pending"),
    summary,
    speakers: data.speakers || [],
    segments: segs,
    source: data.source || "mac",
    language: data.language || "ko",
    fileId: fileMeta.id,
    modifiedTime: fileMeta.modifiedTime,
    audioId: audioMeta?.id || data.audio?.file_id || null,
    audioName: audioMeta?.name || data.audio?.file_name || null,
    webViewLink: fileMeta.webViewLink || null,
    folderName: fileMeta.folderName,
    engine: data.engine || null,
  };
}

function pendingRecord(fileMeta, base) {
  const m = base.match(/^(\d{8})-(\d{4})_([a-z]+)_(.*)$/i);
  const started = m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:00+09:00` : fileMeta.createdTime;
  return {
    id: "p-" + base,
    base,
    title: m ? `${(TYPES[m[3]] || TYPES.etc).label} 녹음` : "전사 대기 중인 녹음",
    type: m && TYPES[m[3]] ? m[3] : "etc",
    started_at: started,
    duration_sec: 0,
    status: "pending",
    summary: {},
    speakers: [],
    segments: [],
    source: fileMeta.folderName === CONFIG.inboxFolder ? "iphone" : "web",
    fileId: null,
    modifiedTime: fileMeta.modifiedTime,
    audioId: fileMeta.id,
    audioName: fileMeta.name,
    folderName: fileMeta.folderName,
    webViewLink: fileMeta.webViewLink || null,
  };
}

function guessTime(base) {
  const m = base.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`;
}

function prettySlug(s) {
  if (!s) return "녹음";
  const t = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 30 ? t.slice(0, 30) + "…" : (t || "녹음");
}

function defaultTitle(started, oneLine) {
  if (oneLine) return oneLine.length > 34 ? oneLine.slice(0, 34) + "…" : oneLine;
  try { return `${fmtDay(started)} 기록`; } catch { return ""; }
}

function reindex() { S.index = buildIndex(S.records); }

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const k = i++;
      try { out[k] = await fn(arr[k], k); } catch (e) { out[k] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ────────────────────────────────── 타임라인 ── */
function typeChips(counts) {
  const order = Object.keys(TYPES).filter((t) => counts[t]);
  const items = [{ k: "all", label: "전체", n: S.records.length }, ...order.map((t) => ({ k: t, label: TYPES[t].label, n: counts[t] }))];
  return items.map((it) => `<button class="chip ${S.filter === it.k ? "on" : ""}" data-f="${it.k}">${it.label} <span style="opacity:.5">${it.n}</span></button>`).join("");
}

function renderTimeline() {
  const list = $("#tl-list");
  if (!S.records.length) {
    $("#tl-month").textContent = "기록";
    $("#tl-sub").textContent = "아직 기록이 없습니다";
    $("#tl-chips").innerHTML = "";
    list.innerHTML = `<div class="empty"><h3>아직 기록이 없습니다</h3><p>아래 녹음 버튼으로 짧게 남기거나,<br>아이폰 음성 메모를 <b>${esc(CONFIG.rootFolder)}</b> 폴더에<br>올리면 맥이 자동으로 전사합니다.</p></div>`;
    return;
  }
  const counts = {};
  S.records.forEach((r) => { counts[r.type] = (counts[r.type] || 0) + 1; });
  const filtered = S.filter === "all" ? S.records : S.records.filter((r) => r.type === S.filter);

  const total = S.records.reduce((a, r) => a + (r.duration_sec || 0), 0);
  const newest = S.records[0];
  $("#tl-month").textContent = fmtMonth(newest.started_at);
  $("#tl-sub").textContent = `기록 ${S.records.length}건 · ${fmtDuration(total)}${S.mode === "demo" ? " · 데모" : ""}`;
  $("#tl-chips").innerHTML = typeChips(counts);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty"><h3>해당 유형의 기록이 없습니다</h3><p>다른 유형을 선택해 보세요.</p></div>`;
    return;
  }

  let html = "";
  let lastDay = "";
  for (const r of filtered) {
    const dk = dayKey(r.started_at);
    if (dk !== lastDay) {
      const rel = relDay(r.started_at);
      html += `<div class="daylabel"><b>${esc(fmtDay(r.started_at))}</b>${rel ? `<span>${rel}</span>` : ""}</div>`;
      lastDay = dk;
    }
    html += cardHTML(r);
  }
  list.innerHTML = html;
  maybeShowInstallTip();

  $$("#tl-chips .chip").forEach((c) => c.addEventListener("click", () => {
    S.filter = c.dataset.f; renderTimeline();
  }));
  $$("#tl-list .card").forEach((c) => c.addEventListener("click", () => {
    const rec = S.records.find((r) => r.id === c.dataset.id);
    if (rec) openDetail(rec);
  }));
}

function cardHTML(r) {
  const t = TYPES[r.type] || TYPES.etc;
  const pending = r.status === "pending";
  const line = r.summary?.one_line || (pending ? "맥에서 전사하면 요약이 표시됩니다" : "");
  const spk = (r.speakers || []).length;
  const metaBits = [];
  if (r.duration_sec) metaBits.push(fmtDuration(r.duration_sec));
  if (spk > 1) metaBits.push(`화자 ${spk}`);
  if (r.source === "iphone") metaBits.push("음성메모");
  else if (r.source === "web") metaBits.push("웹 녹음");
  else if (r.source === "mic") metaBits.push("웹 녹음");
  if (pending) metaBits.push("전사 대기");
  return `<button class="card ${pending ? "pending" : ""}" data-id="${esc(r.id)}">
    <div class="card-time">${esc(fmtTime(r.started_at))}</div>
    <div>
      <div class="card-top">
        <span class="tag ${r.type === "meeting" ? "meeting" : ""}">${esc(t.label)}</span>
        ${pending ? '<span class="tag pending">전사 대기</span>' : ""}
      </div>
      <h3 class="card-title">${esc(r.title)}</h3>
      ${line ? `<p class="card-line">${esc(line)}</p>` : ""}
      <div class="card-meta">${metaBits.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
    </div>
  </button>`;
}

/* ────────────────────────────────── 검색 ── */
function renderSearch() {
  const body = $("#search-body");
  const q = S.query.trim();
  $("#q-clear").hidden = !q;
  const counts = {};
  S.records.forEach((r) => { counts[r.type] = (counts[r.type] || 0) + 1; });
  $("#search-chips").innerHTML = typeChips(counts);
  $$("#search-chips .chip").forEach((c) => c.addEventListener("click", () => { S.filter = c.dataset.f; renderSearch(); }));

  if (S.searchMode === "ask") {
    if (!q) {
      body.innerHTML = `<div class="ask-box"><div class="ask-card">
        <div class="ask-q">기록에 대해 물어보세요</div>
        <div class="note">예: “지난 회의에서 결정된 일정이 뭐였지?”, “울진 출장 관련해서 뭐라고 했어?”<br>
        ${hasGemini() ? "Gemini가 검색된 근거 문장만으로 답합니다." : "Gemini API 키를 설정하면 근거 문장을 모아 답변까지 만들어 줍니다. 지금은 근거 문장만 보여 줍니다."}</div>
      </div></div>`;
      return;
    }
    return;
  }

  if (!q) {
    const kw = keywords(S.index, 8);
    body.innerHTML = `<div class="empty" style="padding-top:34px">
      <h3>기억나지 않는 말을 찾아보세요</h3>
      <p>전사된 모든 문장과 요약을 즉시 검색합니다.<br>검색어는 띄어쓰기가 달라도 찾습니다.</p>
      ${kw.length ? `<div class="chips" style="justify-content:center;padding:18px 4px 0;flex-wrap:wrap">${kw.map((k) => `<button class="chip" data-kw="${esc(k)}">${esc(k)}</button>`).join("")}</div>` : ""}
    </div>`;
    $$("#search-body [data-kw]").forEach((b) => b.addEventListener("click", () => {
      S.query = b.dataset.kw; $("#q").value = S.query; renderSearch();
    }));
    return;
  }

  const hits = doSearch(S.index, q, { type: S.filter, limit: 60 });
  if (!hits.length) {
    body.innerHTML = `<div class="empty"><h3>“${esc(q)}” 검색 결과가 없습니다</h3><p>다른 낱말로 찾아보거나,<br>AI에게 묻기로 물어보세요.</p></div>`;
    return;
  }

  let html = `<div class="search-hint">문장 ${hits.filter((h) => h.kind === "seg").length}건 · 요약 ${hits.filter((h) => h.kind !== "seg").length}건</div>`;
  for (const h of hits) {
    const t = TYPES[h.rec.type] || TYPES.etc;
    const where = h.kind === "seg"
      ? `${esc(fmtTime(h.rec.started_at))} · ${h.t != null ? fmtClock(h.t) + " · " : ""}${esc(h.speaker || "")}`
      : (h.kind === "action" ? "액션 아이템" : h.kind === "decision" ? "결정" : h.kind === "oneliner" ? "한 줄 요약" : "요약");
    html += `<button class="hit" data-rid="${esc(h.rec.id)}" data-t="${h.t != null ? h.t : ""}">
      <div class="hit-meta"><span class="tag ${h.rec.type === "meeting" ? "meeting" : ""}">${esc(t.label)}</span><span>${esc(fmtDay(h.rec.started_at))}</span></div>
      <p class="hit-text">${highlight(h.text, h.tokens)}</p>
      <div class="hit-where">${esc(h.rec.title)} · ${where}</div>
    </button>`;
  }
  body.innerHTML = html;
  $$("#search-body .hit").forEach((b) => b.addEventListener("click", () => {
    const rec = S.records.find((r) => r.id === b.dataset.rid);
    if (rec) openDetail(rec, { seek: b.dataset.t ? Number(b.dataset.t) : null, query: q });
  }));
}

async function runAsk() {
  const q = S.query.trim();
  if (!q) return;
  const body = $("#search-body");
  const hits = evidence(S.index, q, 10);
  if (!hits.length) {
    body.innerHTML = `<div class="empty"><h3>관련 기록을 찾지 못했습니다</h3><p>질문에 나온 낱말로 검색되는 문장이 없습니다.</p></div>`;
    return;
  }
  const srcHTML = `<div class="ask-src"><h4>근거</h4>${hits.map((h, i) => `<button class="src" data-rid="${esc(h.rec.id)}" data-t="${h.t != null ? h.t : ""}">
      <b>[${i + 1}]</b> ${esc(h.text.length > 70 ? h.text.slice(0, 70) + "…" : h.text)} <span>· ${esc(fmtDay(h.rec.started_at))}${h.t != null ? " " + fmtClock(h.t) : ""}</span></button>`).join("")}</div>`;

  if (!hasGemini()) {
    body.innerHTML = `<div class="ask-box"><div class="ask-card">
      <div class="ask-q">${esc(q)}</div>
      <div class="ask-a" style="color:var(--muted)">설정에서 Gemini API 키를 넣으면 이 근거들로 답변을 만들어 드립니다. 지금은 가장 관련 있는 문장을 모았습니다.</div>
      ${srcHTML}
    </div></div>`;
    bindAskSources();
    return;
  }

  body.innerHTML = `<div class="ask-box"><div class="ask-card"><div class="ask-q">${esc(q)}</div>
    <div class="loading"><span class="spinner dark"></span></div></div></div>`;
  try {
    const { answer } = await askGemini(q, hits);
    body.innerHTML = `<div class="ask-box"><div class="ask-card">
      <div class="ask-q">${esc(q)}</div>
      <div class="ask-a">${esc(answer)}</div>
      ${srcHTML}</div></div>`;
  } catch (e) {
    body.innerHTML = `<div class="ask-box"><div class="ask-card">
      <div class="ask-q">${esc(q)}</div>
      <div class="ask-a" style="color:var(--muted)">답변을 만들지 못했습니다: ${esc(e.message || "오류")}</div>
      ${srcHTML}</div></div>`;
  }
  bindAskSources();
}

function bindAskSources() {
  $$("#search-body .src").forEach((b) => b.addEventListener("click", () => {
    const rec = S.records.find((r) => r.id === b.dataset.rid);
    if (rec) openDetail(rec, { seek: b.dataset.t ? Number(b.dataset.t) : null });
  }));
}

/* ────────────────────────────────── 상세 ── */
function openDetail(rec, opts = {}) {
  closeSheet(true);
  const t = TYPES[rec.type] || TYPES.etc;
  const sum = rec.summary || {};
  const metaBits = [fmtDay(rec.started_at), fmtTime(rec.started_at)];
  if (rec.duration_sec) metaBits.push(fmtDuration(rec.duration_sec));
  if ((rec.speakers || []).length) metaBits.push(rec.speakers.join(", "));
  if (rec.source === "iphone") metaBits.push("아이폰 음성메모");

  const sec = (title, inner) => `<section class="detail-sec"><h3>${title}</h3>${inner}</section>`;
  const bullets = (arr) => arr?.length ? `<ul class="bullets">${arr.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";

  let bodyHTML = "";
  if (rec.status === "pending") {
    bodyHTML += sec("전사 대기", `<p class="oneline" style="font-size:15px;color:var(--muted)">${esc(rec.folderName === CONFIG.inboxFolder ? "아이폰에서 올린 파일입니다. 맥이 전사하면 요약과 전사문이 채워집니다." : "맥 전사 대기 중입니다. 전사가 끝나면 이 화면에 요약과 문장이 표시됩니다.")}</p>
      ${hasGemini() ? `<button class="btn btn-line btn-block" id="btn-quick-transcribe" style="margin-top:14px">지금 이 기기에서 전사하기</button>` : ""}`);
  }

  if (sum.one_line) bodyHTML += sec("요약", `<p class="oneline">${esc(sum.one_line)}</p>`);
  if (sum.agenda?.length) bodyHTML += sec("안건", bullets(sum.agenda));
  if (sum.decisions?.length) bodyHTML += sec("결정", bullets(sum.decisions));
  if (sum.actions?.length) {
    bodyHTML += sec("액션 아이템", `<ul class="bullets actions">${sum.actions.map((a) => `<li>${a.owner ? `<span class="own">${esc(a.owner)}</span>` : ""}<span>${esc(a.task || "")}${a.due ? ` <span style="color:var(--muted)">· ${esc(a.due)}</span>` : ""}</span></li>`).join("")}</ul>`);
  }
  if (sum.bullets?.length) bodyHTML += sec(sum.agenda?.length || sum.decisions?.length ? "그 밖의 내용" : "핵심", bullets(sum.bullets));
  if (sum.keywords?.length) bodyHTML += sec("키워드", `<div class="chips" style="padding:0;flex-wrap:wrap">${sum.keywords.map((k) => `<button class="chip" data-kw="${esc(k)}">${esc(k)}</button>`).join("")}</div>`);

  if (rec.segments?.length) {
    bodyHTML += `<section class="detail-sec" style="padding-bottom:4px"><h3>전사 ${rec.segments.length}문장</h3><div class="tr-hint">문장을 누르면 그 지점부터 재생됩니다.</div></section>
      <div class="transcript" id="transcript">${rec.segments.map((s) => `<button class="tr" data-t="${s.start}" data-i="${s.i}">
        <span class="tr-t">${fmtClock(s.start)}</span>
        <span class="tr-body">${s.speaker ? `<span class="tr-sp">${esc(s.speaker)}</span>` : ""}${esc(s.text)}</span>
      </button>`).join("")}</div>`;
  }

  if (rec.webViewLink) {
    bodyHTML += `<section class="detail-sec"><a href="${esc(rec.webViewLink)}" target="_blank" rel="noopener" style="font-size:12.5px;color:var(--muted);text-decoration:underline;text-underline-offset:3px">드라이브에서 원본 열기</a></section>`;
  }

  const hasAudio = !!rec.audioId && S.mode === "live";
  const foot = rec.segments?.length || hasAudio
    ? `<div class="player" id="player">
        <button class="pl-btn" id="pl-toggle" aria-label="재생">▶</button>
        <button class="pl-btn small" id="pl-back" aria-label="15초 뒤로">−15</button>
        <div class="pl-mid">
          <div class="pl-title" id="pl-title">${esc(rec.title)}</div>
          <div class="pl-bar"><i id="pl-fill"></i></div>
          <div class="pl-time"><span id="pl-cur">00:00</span><span id="pl-dur">${fmtClock(rec.duration_sec || 0)}</span></div>
        </div>
        <button class="pl-btn small" id="pl-fwd" aria-label="15초 앞으로">+15</button>
        <button class="pl-btn small" id="pl-rate" aria-label="재생 속도">1×</button>
      </div>
      ${hasAudio ? "" : '<div style="font-size:11px;color:var(--muted-2);margin-top:8px">데모 · 오디오 파일이 없습니다</div>'}`
    : "";

  const sheet = openSheet({
    title: rec.title,
    sub: `<span>${esc(metaBits.join(" · "))}</span><span class="tag ${rec.type === "meeting" ? "meeting" : ""}" style="margin-left:auto">${esc(t.label)}</span>`,
    body: bodyHTML,
    foot,
    tall: true,
  });

  // 키워드 → 검색 이동
  $$("[data-kw]", sheet).forEach((b) => b.addEventListener("click", () => {
    S.query = b.dataset.kw; $("#q").value = S.query; S.searchMode = "search";
    $$("#search-mode button").forEach((x) => x.classList.toggle("on", x.dataset.mode === "search"));
    closeSheet(); setTab("search"); renderSearch();
  }));

  if (rec.status === "pending" && $("#btn-quick-transcribe")) {
    $("#btn-quick-transcribe").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = "전사 중…";
      try {
        const blob = await fetchAudioBlob(rec.audioId);
        const data = await geminiTranscribe(blob, { hint: "짧은 개인 메모" });
        await uploadTranscriptForExisting(rec, data, blob);
        toast("전사했습니다");
        closeSheet(); await syncNow();
      } catch (err) {
        toast(err.message || "전사하지 못했습니다");
        btn.disabled = false; btn.textContent = "지금 이 기기에서 전사하기";
      }
    });
  }

  setupPlayer(rec, opts);
}

async function fetchAudioBlob(fileId) {
  await drive.ensureToken();
  const res = await fetch(`${CONFIG.driveApi}/files/${fileId}?alt=media`, {
    headers: { Authorization: "Bearer " + drive.token },
  });
  if (!res.ok) throw new Error("오디오를 내려받지 못했습니다 (" + res.status + ")");
  return res.blob();
}

function setupPlayer(rec, opts = {}) {
  const audio = new Audio();
  audio.preload = "metadata";
  audio.setAttribute("playsinline", "");
  audio.style.display = "none";
  let rate = 1;
  const nodes = {
    toggle: $("#pl-toggle"), fill: $("#pl-fill"), cur: $("#pl-cur"), dur: $("#pl-dur"),
    title: $("#pl-title"), rate: $("#pl-rate"),
  };
  if (!nodes.toggle) return;

  if (rec.audioId && S.mode === "live" && drive.token) {
    audio.src = drive.audioUrl(rec.audioId);
  }
  let tokenRetried = false;
  audio.addEventListener("error", async () => {
    if (tokenRetried || !rec.audioId || S.mode !== "live") return;
    tokenRetried = true;
    try {
      await drive.ensureToken();
      audio.src = drive.audioUrl(rec.audioId);
    } catch {}
  });

  const icon = (playing) => (playing
    ? '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" style="margin-left:2px"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>');

  nodes.toggle.parentElement.appendChild(audio);
  const setPlaying = (p) => { nodes.toggle.innerHTML = icon(p); };
  setPlaying(false);

  const seek = (t) => {
    if (!audio.src) { highlightSegment(t); return; }
    try { audio.currentTime = Math.max(0, t); } catch {}
    if (!audio.paused) return;
    audio.play().then(() => setPlaying(true)).catch(() => toast("오디오를 재생할 수 없습니다"));
  };

  nodes.toggle.addEventListener("click", () => {
    if (!audio.src) {
      if (rec.demo) return toast("데모에는 오디오가 없습니다");
      return toast("오디오 파일이 없습니다");
    }
    if (audio.paused) audio.play().then(() => setPlaying(true)).catch((e) => toast("재생 실패: " + e.message));
    else { audio.pause(); setPlaying(false); }
  });

  $("#pl-back").addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  $("#pl-fwd").addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 15); });
  nodes.rate.addEventListener("click", () => {
    rate = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 0.8 : 1;
    audio.playbackRate = rate;
    nodes.rate.textContent = rate + "×";
  });

  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration)) nodes.dur.textContent = fmtClock(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    const d = audio.duration || rec.duration_sec || 1;
    nodes.fill.style.width = Math.min(100, (audio.currentTime / d) * 100) + "%";
    nodes.cur.textContent = fmtClock(audio.currentTime);
    highlightSegment(audio.currentTime);
  });
  audio.addEventListener("ended", () => setPlaying(false));
  audio.addEventListener("pause", () => setPlaying(false));
  audio.addEventListener("play", () => setPlaying(true));

  let segNodes = [];
  function collectSegNodes() {
    segNodes = $$("#transcript .tr");
  }
  collectSegNodes();

  function highlightSegment(t) {
    if (!segNodes.length) return;
    let active = null;
    for (const n of segNodes) {
      if (Number(n.dataset.t) <= t + 0.15) active = n; else break;
    }
    if (active && !active.classList.contains("on")) {
      segNodes.forEach((n) => n.classList.remove("on"));
      active.classList.add("on");
    }
  }

  segNodes.forEach((n) => n.addEventListener("click", () => {
    const t = Number(n.dataset.t);
    if (rec.demo && !audio.src) return toast("데모에는 오디오가 없습니다");
    seek(t);
  }));

  if (opts.seek != null) {
    setTimeout(() => {
      seek(opts.seek);
      const n = segNodes.find((x) => Number(x.dataset.t) <= opts.seek && Number(x.dataset.t) + 8 > opts.seek);
      n?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 260);
  } else if (opts.query) {
    setTimeout(() => {
      const n = segNodes.find((x) => x.textContent.includes(opts.query));
      n?.scrollIntoView({ block: "center" });
      n?.classList.add("on");
    }, 260);
  }

  S.player = { audio, rec, stop: () => { try { audio.pause(); audio.src = ""; } catch {} } };
}

/* ────────────────────────────────── 시트 ── */
function openSheet({ title = "", sub = "", body = "", foot = "", tall = false, onClose = null, noClose = false } = {}) {
  closeSheet(true);
  const root = $("#sheet-root");
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "sheet" + (tall ? " tall" : "");
  sheet.innerHTML = `
    <div class="sheet-head">
      <div class="grab"></div>
      ${title ? `<h2 class="sheet-title">${esc(title)}</h2>` : ""}
      ${sub ? `<div class="sheet-sub">${sub}</div>` : ""}
      ${noClose ? "" : '<button class="sheet-close" aria-label="닫기">✕</button>'}
    </div>
    <div class="sheet-body">${body}</div>
    ${foot ? `<div class="sheet-foot">${foot}</div>` : ""}`;
  root.append(backdrop, sheet);
  requestAnimationFrame(() => { backdrop.classList.add("show"); sheet.classList.add("show"); });

  const close = () => closeSheet();
  backdrop.addEventListener("click", close);
  $(".sheet-close", sheet)?.addEventListener("click", close);
  sheet._onClose = onClose;
  S.sheet = sheet;

  // 아래로 드래그해 닫기
  const head = $(".sheet-head", sheet);
  let startY = null, delta = 0;
  head.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
  head.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    delta = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${delta}px)`;
  }, { passive: true });
  head.addEventListener("touchend", () => {
    if (delta > 90) close();
    else sheet.style.transform = "";
    startY = null; delta = 0;
  });
  return sheet;
}

let _sheetClearTimer = null;
function closeSheet(immediate = false) {
  S.player?.stop?.();
  S.player = null;
  const root = $("#sheet-root");
  const sheet = root.querySelector(".sheet");
  const backdrop = root.querySelector(".sheet-backdrop");
  clearTimeout(_sheetClearTimer);
  if (!sheet) { if (immediate) root.innerHTML = ""; return; }
  try { sheet._onClose?.(); } catch (e) { console.warn(e); }
  if (immediate) { root.innerHTML = ""; return; }
  sheet.style.transform = "";
  sheet.classList.remove("show");
  backdrop?.classList.remove("show");
  _sheetClearTimer = setTimeout(() => { root.innerHTML = ""; }, 260);
}

/* ────────────────────────────────── 설정 ── */
async function renderSettings() {
  const body = $("#settings-body");
  const s = localSettings();
  const lastSync = S.lastSync ? new Date(S.lastSync) : null;
  const email = localStorage.getItem("hemory.email") || "";
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const sch = getSchedule();
  const _now = new Date();
  const schedNow = {
    d: DAY_LABELS[_now.getDay()],
    hm: `${String(_now.getHours()).padStart(2, "0")}:${String(_now.getMinutes()).padStart(2, "0")}`,
    inside: !!scheduleActiveNow(_now),
  };

  body.innerHTML = `
  <div class="sgroup">
    <h2>계정</h2>
    <div class="srow"><span class="k">${S.mode === "live" ? "Google 드라이브 연결됨" : "연결 안 됨"}</span>
      <span class="v">${esc(email || (drive.signedIn ? "연결됨" : "—"))}</span></div>
    <div class="srow"><span class="k">마지막 동기화</span><span class="v">${lastSync ? lastSync.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "—"}</span></div>
    <div class="srow"><span class="k">저장 위치</span><span class="v">내 드라이브 / ${esc(CONFIG.rootFolder)}</span></div>
    <div class="srow"><span class="k">보관 기간</span><span class="v">${CONFIG.retentionDays}일 지나면 자동 정리</span></div>
    <button class="btn btn-line btn-block" id="s-sync">지금 동기화</button>
    ${S.mode === "live" ? '<button class="btn btn-ghost btn-block" id="s-out">연결 해제</button>' : '<button class="btn btn-ghost btn-block" id="s-login">Google 연결</button>'}
  </div>

  <div class="sgroup">
    <h2>AI</h2>
    <div class="srow"><span class="k">Gemini API 키</span><span class="v">${hasGemini() ? "설정됨" : "없음"}</span></div>
    <p class="note">키가 있으면 ① 기록에 질문해 답을 만들고 ② 짧은 녹음을 폰에서 바로 전사합니다. 키는 이 기기에만 저장되고 드라이브에 올라가지 않습니다.</p>
    <div class="field"><label>API 키 (AI Studio에서 발급)</label>
      <input id="s-key" type="password" inputmode="text" autocomplete="off" spellcheck="false" placeholder="AIza..." value="${esc(s.geminiKey || "")}">
      <div class="hint">비워 두면 검색·재생만 하고, 전사·요약은 맥이 담당합니다.</div></div>
    <button class="btn btn-line btn-block" id="s-key-save">키 저장</button>
  </div>

  <div class="sgroup">
    <h2>인증 설정 · 최초 1회</h2>
    <div class="srow"><span class="k">Client ID</span><span class="v">${drive.configured ? "설정됨" : "없음"}</span></div>
    <p class="note">Google Cloud Console에서 OAuth 클라이언트 ID(웹)를 만들고, 승인된 JavaScript 출처에 이 주소를 추가한 뒤 아래에 붙여 넣습니다. 자세한 순서는 저장소 docs/setup-oauth.md.</p>
    <div class="field"><label>OAuth Client ID</label>
      <input id="s-client" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="....apps.googleusercontent.com" value="${esc(drive.clientId)}"></div>
    <button class="btn btn-line btn-block" id="s-client-save">Client ID 저장</button>
  </div>

  <div class="sgroup">
    <h2>아이폰에서 쓰기</h2>
    <div class="srow"><span class="k">홈 화면 앱</span><span class="v">${standalone ? "앱 모드로 실행 중" : "Safari 공유 → 홈 화면에 추가"}</span></div>
    <p class="note">① Safari로 이 페이지를 연 뒤 <b>공유 → 홈 화면에 추가</b>하면 주소창 없는 앱처럼 열립니다.<br>
    ② 화면이 꺼져도 계속 녹음하려면 <b>음성 메모</b>로 녹음한 뒤 공유 → <b>Google 드라이브</b> → <b>${esc(CONFIG.rootFolder)} / ${esc(CONFIG.inboxFolder)}</b>에 저장하세요. 맥이 자동으로 전사합니다.<br>
    ③ 짧은 메모는 이 앱의 녹음 버튼으로 바로 남길 수 있습니다.</p>
    <button class="btn btn-line btn-block" id="s-guide">아이폰 단축어 가이드 보기</button>
  </div>

  <div class="sgroup">
    <h2>예약 녹음</h2>
    <div class="srow"><span class="k">예약 녹음 모드</span>
      <button class="sw" id="s-sch-on" role="switch" aria-checked="${sch.enabled ? "true" : "false"}" aria-label="예약 녹음 모드"><i></i></button></div>
    <p class="note">앱이 열려 있을 때, 정한 요일·시간이 되면 <b>자동으로 녹음을 시작</b>하고 끝나는 시각에 <b>자동 저장</b>합니다. 화면 꺼짐 방지·침묵 건너뛰기도 함께 켜집니다. 종일 녹음은 충전기에 꼽아 두세요.</p>
    <div class="chips" style="padding:0 0 6px">
      ${Object.entries(TYPES).map(([k, v]) => `<button class="chip ${sch.type === k ? "on" : ""}" data-stype="${k}">${v.label}</button>`).join("")}
    </div>
    <div class="sch">
      ${DAY_KEYS.map((k, i) => {
        const d = sch.days[k];
        return `<div class="sch-row">
          <button class="sch-day ${d.on ? "on" : ""}" data-day="${k}" aria-pressed="${d.on}" aria-label="${DAY_LABELS[i]}요일 ${d.on ? "켜짐" : "꺼짐"}">${DAY_LABELS[i]}</button>
          <input type="time" data-day="${k}" data-k="start" value="${d.start}" step="60" aria-label="${DAY_LABELS[i]} 시작 시간"${d.on ? "" : " disabled"}>
          <span class="sch-dash">~</span>
          <input type="time" data-day="${k}" data-k="end" value="${d.end}" step="60" aria-label="${DAY_LABELS[i]} 종료 시간"${d.on ? "" : " disabled"}>
        </div>`;
      }).join("")}
    </div>
    <div class="sch-hint"><span>지금 ${schedNow.d}요일 ${schedNow.hm} · ${schedNow.inside ? "녹음 시간 안" : "녹음 시간 밖"}</span></div>
    <p class="note">월~일 각각 켜고 끄고, 자정을 넘기는 구간(예: 22:00~06:00)도 됩니다. 아이폰은 앱을 한 번 탭해야 마이크가 열리므로, 자동 시작이 막히면 화면을 한 번 탭해 주세요.</p>
  </div>

  <div class="sgroup">
    <h2>데이터</h2>
    <div class="srow"><span class="k">기록</span><span class="v">${S.records.length}건 (이 기기 캐시)</span></div>
    <button class="btn btn-line btn-block" id="s-clear">이 기기 캐시 비우기</button>
    ${S.mode === "demo" ? '<button class="btn btn-ghost btn-block" id="s-demo-exit">데모 종료</button>' : ""}
    <p class="note">캐시를 비워도 드라이브의 원본은 그대로입니다. 공개 저장소에는 어떤 녹음·전사도 올라가지 않습니다.</p>
  </div>

  <div class="sgroup">
    <h2>정보</h2>
    <div class="srow"><span class="k">버전</span><span class="v">${CONFIG.version}</span></div>
    <div class="srow"><span class="k">전사 파이프라인</span><span class="v">맥 자동 처리</span></div>
  </div>`;

  $("#s-sync").addEventListener("click", () => syncNow({ manual: true }));
  $("#s-out")?.addEventListener("click", () => {
    drive.signOut();
    S.mode = null; S.records = [];
    toast("연결을 해제했습니다");
    location.reload();
  });
  $("#s-login")?.addEventListener("click", async () => {
    try { await drive.signIn({ interactive: true }); enterLive(); } catch (e) { toast(e.message); }
  });
  $("#s-key-save").addEventListener("click", () => {
    saveSettings({ geminiKey: $("#s-key").value.trim() });
    toast("저장했습니다");
    renderSettings();
  });
  $("#s-client-save").addEventListener("click", () => {
    const v = $("#s-client").value.trim();
    if (v && !v.endsWith(".apps.googleusercontent.com")) return toast("Client ID 형식이 아닙니다");
    drive.setClientId(v);
    toast(v ? "Client ID를 저장했습니다" : "Client ID를 지웠습니다");
    renderSettings();
  });
  $("#s-clear").addEventListener("click", async () => {
    await store.clearAll();
    S.records = []; reindex(); renderTimeline(); renderSettings();
    toast("이 기기 캐시를 비웠습니다");
  });
  $("#s-demo-exit")?.addEventListener("click", () => { S.mode = null; S.records = []; location.reload(); });
  $("#s-guide")?.addEventListener("click", openShortcutGuide);

  /* 예약 녹음 */
  $("#s-sch-on").addEventListener("click", () => {
    const next = saveSchedule({ enabled: !getSchedule().enabled });
    renderSettings();
    toast(next.enabled ? "예약 녹음 모드를 켰습니다" : "예약 녹음 모드를 껐습니다");
    schedTick();
  });
  $$("#settings-body .sch-day").forEach((btn) => btn.addEventListener("click", () => {
    const k = btn.dataset.day;
    const cur = getSchedule();
    const days = { ...cur.days, [k]: { ...cur.days[k], on: !cur.days[k].on } };
    saveSchedule({ days });
    renderSettings();
    schedTick();
  }));
  $$("#settings-body .sch-row input[type=time]").forEach((inp) => inp.addEventListener("change", () => {
    const k = inp.dataset.day, field = inp.dataset.k, val = inp.value;
    if (!/^\d{2}:\d{2}$/.test(val)) return toast("시간을 다시 확인해 주세요");
    const cur = getSchedule();
    const days = { ...cur.days, [k]: { ...cur.days[k], [field]: val } };
    saveSchedule({ days });
    toast("예약 시간을 저장했습니다");
    schedTick();
  }));
  $$("#settings-body [data-stype]").forEach((b) => b.addEventListener("click", () => {
    saveSchedule({ type: b.dataset.stype });
    renderSettings();
  }));
}

/* ────────────────────────────────── 아이폰 단축어 가이드 ── */
function openShortcutGuide() {
  const inbox = `${CONFIG.rootFolder} / ${CONFIG.inboxFolder}`;
  openSheet({
    title: "아이폰 단축어 가이드",
    sub: "한 번만 만들면 음성 메모가 바로 드라이브로",
    body: `<div style="padding:2px 2px 0">
      <div class="guide-block">
        <h3>① 음성 메모 → 드라이브 원탭 업로드</h3>
        <div class="guide-step"><b>1</b><span>단축어 앱 → 오른쪽 위 <b>+</b> → 이름을 <b>Hemory에 저장</b>으로.</span></div>
        <div class="guide-step"><b>2</b><span>아래 검색창에서 <b>파일 저장</b>(Save File) 액션 추가.</span></div>
        <div class="guide-step"><b>3</b><span>액션의 <b>서비스 위치</b>에서 <b>Google 드라이브</b> → 경로 <b>${esc(inbox)}</b> 선택.</span></div>
        <div class="guide-step"><b>4</b><span>입력은 <b>단축어 입력</b> 그대로 두고, <b>덮어쓰기 확인</b>은 끄기.</span></div>
        <div class="guide-step"><b>5</b><span>(선택) 단축어 수정 화면 → 공유 → <b>홈 화면에 추가</b>.</span></div>
        <div class="guide-step"><b>6</b><span>음성 메모 앱 → 녹음 선택 → <b>공유</b> → 목록을 넘겨 <b>Hemory에 저장</b> 탭. 자주 쓰면 공유 시트에서 위로 올려 두세요.</span></div>
        <p class="note" style="margin:10px 0 0">저장된 파일은 맥이 다음 실행에 전사·요약해 달별 폴더로 옮깁니다.</p>
      </div>

      <div class="guide-block">
        <h3>② 정한 요일·시간에 자동 알림(또는 앱 열기)</h3>
        <div class="guide-step"><b>1</b><span>단축어 앱 → 하단 <b>자동화</b> → <b>+</b> → <b>특정 시간</b>.</span></div>
        <div class="guide-step"><b>2</b><span>시간(예: 09:00), 반복은 <b>매일</b> 또는 요일 지정에서 필요한 요일만.</span></div>
        <div class="guide-step"><b>3</b><span>동작: <b>알림 표시</b>(놓치지 않게) 또는 <b>앱 열기 → 음성 메모</b>(바로 녹음 화면).</span></div>
        <div class="guide-step"><b>4</b><span><b>실행 전 확인</b>을 끄면 잠금을 풀지 않아도 알림이 뜨고, 켜면 실행 전에 한 번 물어봅니다.</span></div>
        <p class="note" style="margin:10px 0 0">이 앱으로 받으려면 자동화의 앱 열기를 <b>Hemory 홈 화면 앱</b>으로 두고, 설정 → <b>예약 녹음</b>에서 요일·시간을 켜 두세요. 앱이 열린 상태에서 영역 안이면 자동으로 녹음을 시작합니다.</p>
      </div>

      <div class="guide-block">
        <h3>③ 동작 버튼에 음성 메모 달기</h3>
        <div class="guide-step"><b>1</b><span>설정 → <b>동작 버튼</b> → 옆으로 넘겨 <b>음성 메모</b> 선택.</span></div>
        <div class="guide-step"><b>2</b><span>이제 버튼을 길게 누르면 녹음이 바로 시작됩니다. (카메라·손전등 등 기존 기능은 다른 걸로 바꿀 수 있습니다)</span></div>
        <p class="note" style="margin:10px 0 0">동작 버튼에서 음성 메모가 보이지 않으면 설정 → 동작 버튼 → <b>단축어</b>를 고르고 ①에서 만든 단축어를 연결해도 됩니다.</p>
      </div>

      <p class="note">더 자세한 내용은 저장소 <b>docs/iphone.md</b> 에도 있습니다.</p>
    </div>`,
  });
}

function openSetupSheet() {
  const sheet = openSheet({
    title: "처음 설정",
    sub: "Google Cloud에서 5분이면 끝납니다",
    body: `<div style="padding:4px 4px 0">
      <ol style="padding-left:18px;font-size:13.5px;line-height:1.85;color:var(--ink-2);margin:8px 0 14px">
        <li>console.cloud.google.com → 새 프로젝트 <b>hemory-personal</b></li>
        <li>API 및 서비스 → 라이브러리 → <b>Google Drive API</b> 사용 설정</li>
        <li>OAuth 동의 화면 → 외부 → 테스트 사용자에 <b>본인 계정</b> 추가</li>
        <li>사용자 인증 정보 → OAuth 클라이언트 ID → <b>웹 애플리케이션</b></li>
        <li>승인된 JavaScript 출처: <code>https://tessios.github.io</code><br>
            승인된 리디렉션 URI: <code>https://tessios.github.io/my-hemory/</code></li>
        <li>발급된 ID를 아래에 붙여 넣기</li>
      </ol>
      <div class="field"><label>OAuth Client ID</label>
        <input id="setup-client" type="text" autocomplete="off" spellcheck="false" placeholder="....apps.googleusercontent.com" value="${esc(drive.clientId)}"></div>
      <button class="btn btn-primary btn-block" id="setup-save">저장하고 계속</button>
      <p class="note">Client ID는 비밀이 아닙니다(브라우저에 노출되는 공개 값). 개인 기록은 오직 내 드라이브에만 저장되고, 이 저장소에는 코드만 있습니다.</p>
    </div>`,
  });
  $("#setup-save", sheet).addEventListener("click", () => {
    const v = $("#setup-client", sheet).value.trim();
    if (!v.endsWith(".apps.googleusercontent.com")) return toast("Client ID 형식이 아닙니다");
    drive.setClientId(v);
    closeSheet();
    $("#btn-signin").textContent = "Google 계정으로 시작";
    toast("저장했습니다 · 이제 Google 계정으로 시작하세요");
  });
}

/* ────────────────────────────────── 녹음 ── */
function openRecorder() {
  const R = S.recorder;
  if (S.auto.on || S.face.active) {
    return toast("예약·뒤집어 녹음이 진행 중입니다. 먼저 종료해 주세요");
  }
  if (R.state !== "idle" && R.state !== "done") { R.cancel(); }
  let saved = null;
  let vad = localSettings().vad !== false; // 기본 ON
  let faceOn = faceDownPref();
  const wakeOK = Recorder.wakeSupported;
  const vadOK = Recorder.vadSupported;

  const sheet = openSheet({
    title: "녹음",
    sub: "짧은 메모는 여기서, 긴 회의는 아이폰 음성 메모로",
    body: `<div class="rec-wrap">
      <div class="rec-timer" id="rec-timer">00:00</div>
      <div class="rec-state" id="rec-state">대기 중</div>
      <div class="rec-badges" id="rec-badges"></div>
      <div class="wave" id="rec-wave">${Array.from({ length: 32 }, () => '<i></i>').join("")}</div>
      <div class="rec-controls" id="rec-controls">
        <button class="rec-side" id="rec-file" title="파일 가져오기" aria-label="파일 가져오기">파일</button>
        <button class="rec-main" id="rec-main">시작</button>
        <button class="rec-side" id="rec-pause" title="일시정지" aria-label="일시정지" disabled>일시</button>
      </div>
      <div class="rec-opt">
        <div class="rec-opt-txt"><b>침묵 구간 자동 건너뛰기</b>
          <span>${vadOK ? "말하지 않는 동안은 소리를 담지 않고, 전사도 말한 구간만 합니다 (VAD)" : "이 브라우저에서는 사용할 수 없습니다"}</span></div>
        <button class="sw" id="rec-vad" role="switch" aria-checked="${vad && vadOK ? "true" : "false"}" aria-label="침묵 구간 자동 건너뛰기"${vadOK ? "" : " disabled"}><i></i></button>
      </div>
      <div class="rec-opt">
        <div class="rec-opt-txt"><b>뒤집어서 자동 녹음</b>
          <span>폰을 엎어 두면 1.5초 뒤 녹음이 시작되고 화면은 검게 절전합니다. 다시 들면 자동 저장</span></div>
        <button class="sw" id="rec-face" role="switch" aria-checked="${faceOn ? "true" : "false"}" aria-label="뒤집어서 자동 녹음"${window.DeviceOrientationEvent ? "" : " disabled"}><i></i></button>
      </div>
      <div id="rec-save-area"></div>
      <div class="rec-note" id="rec-note">${wakeOK
        ? "녹음 중에는 화면이 저절로 꺼지지 않도록 화면 잠금을 걸어 둡니다(iOS 16.4+). 다만 직접 화면을 잠그거나 전화가 오면 Safari가 마이크를 끊습니다 — 종일 녹음은 충전기에 꽂고 화면을 켜 둔 채 쓰세요."
        : "이 브라우저는 녹음 중 화면 꺼짐 방지를 지원하지 않습니다(iOS 16.4+ Safari 필요). 화면이 꺼지거나 전화가 오면 녹음이 멈춥니다. 긴 회의·강의는 <b>아이폰 음성 메모</b>로 녹음해 공유 → Google 드라이브 → <b>" + esc(CONFIG.inboxFolder) + "</b>에 저장하면 맥이 전사합니다."}</div>
    </div>`,
    tall: false,
  });
  sheet._rec = true;

  const timerEl = $("#rec-timer", sheet);
  const stateEl = $("#rec-state", sheet);
  const waveEl = $("#rec-wave", sheet);
  const mainBtn = $("#rec-main", sheet);
  const pauseBtn = $("#rec-pause", sheet);
  const fileBtn = $("#rec-file", sheet);
  const saveArea = $("#rec-save-area", sheet);
  const badgesEl = $("#rec-badges", sheet);
  const vadBtn = $("#rec-vad", sheet);
  let tick = null, raf = null;

  const recording = () => R.state === "recording" || R.state === "paused";

  /* 상태 배지 — 화면 꺼짐 방지·VAD */
  function paint() {
    const bits = [];
    if (R.wake === "held") bits.push(`<span class="rec-badge on">화면 꺼짐 방지 켜짐</span>`);
    else if (recording()) bits.push(`<span class="rec-badge">화면 꺼짐 방지 대기</span>`);
    else if (!wakeOK) bits.push(`<span class="rec-badge">화면 꺼짐 방지 미지원</span>`);
    if (R.vad || (vad && vadOK && !recording() && R.state === "idle")) {
      const t = recording() || R.state === "done" ? ` · 말한 구간 ${fmtClock(R.speechSec || 0)}` : "";
      bits.push(`<span class="rec-badge${recording() && R.speaking ? " on" : ""}">VAD${t}</span>`);
    }
    if (!bits.length) bits.push(`<span class="rec-badge">말한 구간만 담기 · 화면 꺼짐 방지</span>`);
    badgesEl.innerHTML = bits.join("");
  }

  vadBtn.addEventListener("click", () => {
    if (recording()) return;
    vad = !vad;
    saveSettings({ vad });
    vadBtn.setAttribute("aria-checked", vad ? "true" : "false");
    paint();
  });

  const faceBtn = $("#rec-face", sheet);
  faceBtn?.addEventListener("click", async () => {
    if (faceOn) {
      faceOn = false;
      saveSettings({ faceDown: false });
      stopFaceWatcher();
      faceBtn.setAttribute("aria-checked", "false");
      toast("뒤집어서 자동 녹음을 껐습니다");
      return;
    }
    const ok = await askMotionPermission();
    if (!ok) return toast("설정 → Safari → 동작 및 방향 접근을 허용해야 쓸 수 있습니다");
    faceOn = true;
    saveSettings({ faceDown: true });
    startFaceWatcher();
    faceBtn.setAttribute("aria-checked", "true");
    toast("폰을 엎어 두면 1.5초 뒤 녹음이 시작됩니다");
  });

  addRecListener(paint);
  paint();

  const bars = $$("i", waveEl);
  function draw() {
    if (R.state === "recording") {
      const lv = R.level();
      const h = 6 + lv * 52;
      const i = Math.floor(Date.now() / 90) % bars.length;
      bars[i].style.height = h.toFixed(1) + "px";
      for (let k = 0; k < bars.length; k++) {
        const cur = parseFloat(bars[k].style.height) || 6;
        bars[k].style.height = Math.max(6, cur * 0.92).toFixed(1) + "px";
      }
    }
    raf = requestAnimationFrame(draw);
  }

  function stopTimers() { clearInterval(tick); cancelAnimationFrame(raf); tick = null; raf = null; }

  function updateTimer() { timerEl.textContent = fmtClock(R.elapsedSec()); }

  mainBtn.addEventListener("click", async () => {
    if (R.state === "idle") {
      try {
        await R.start({ vad });
      } catch (e) {
        return toast("마이크를 사용할 수 없습니다: " + (e.message || "권한 확인"));
      }
      haptic(12);
      mainBtn.textContent = "정지";
      mainBtn.classList.add("stop");
      pauseBtn.disabled = false;
      vadBtn.disabled = true;
      stateEl.textContent = "녹음 중";
      if (vad && !R.vad) toast("이 브라우저에서는 침묵 건너뛰기를 켤 수 없습니다");
      paint();
      tick = setInterval(() => { updateTimer(); paint(); }, 250);
      draw();
      return;
    }
    if (R.state === "recording" || R.state === "paused") {
      const out = await R.stop();
      stopTimers();
      haptic([10, 40, 10]);
      mainBtn.textContent = "다시";
      mainBtn.classList.remove("stop");
      pauseBtn.disabled = true;
      vadBtn.disabled = !vadOK;
      stateEl.textContent = "녹음 완료 · 저장하세요";
      saved = out;
      timerEl.textContent = fmtClock(R.elapsedSec());
      paint();
      showSaveForm(sheet, out, saveArea, () => { closeSheet(); });
      return;
    }
    // 다시
    saved = null;
    saveArea.innerHTML = "";
    timerEl.textContent = "00:00";
    stateEl.textContent = "대기 중";
    mainBtn.textContent = "시작";
    vadBtn.disabled = !vadOK;
    bars.forEach((b) => (b.style.height = "6px"));
    paint();
  });

  pauseBtn.addEventListener("click", () => {
    if (R.state === "recording") { R.pause(); pauseBtn.textContent = "재개"; stateEl.textContent = "일시정지"; }
    else if (R.state === "paused") { R.resume(); pauseBtn.textContent = "일시"; stateEl.textContent = "녹음 중"; }
    paint();
  });

  fileBtn.addEventListener("click", async () => {
    const f = await pickAudioFile();
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) return toast("200MB 이하 파일만 올릴 수 있습니다");
    const dur = await probeDuration(f);
    saved = { blob: f, duration: dur, mime: f.type, name: f.name };
    stateEl.textContent = "파일 선택됨";
    timerEl.textContent = fmtClock(dur);
    showSaveForm(sheet, saved, saveArea, () => closeSheet());
  });

  // 시트 닫힐 때 정리
  sheet._onClose = () => {
    stopTimers();
    delRecListener(paint);
    if (S.recorder.state === "recording" || S.recorder.state === "paused") S.recorder.cancel();
  };
}

function showSaveForm(sheet, out, area, done) {
  const now = new Date();
  const defaultTitle = `새 녹음 ${fmtTime(now.toISOString())}`;
  area.innerHTML = `<div class="rec-save">
    <div class="field"><label>제목</label>
      <input id="rec-title" type="text" value="${esc(defaultTitle)}" placeholder="예: 현장 회의 메모"></div>
    <div class="field"><label>유형</label>
      <div class="chips" id="rec-types" style="padding:0">
        ${Object.entries(TYPES).map(([k, v], i) => `<button class="chip ${i === 0 ? "" : ""}" data-t="${k}">${v.label}</button>`).join("")}
      </div></div>
    <button class="btn btn-primary btn-block" id="rec-save">드라이브에 저장</button>
    <div style="font-size:11.5px;color:var(--muted-2);margin-top:8px;text-align:center">${recInfo(out)}</div>
  </div>`;

  let type = "work";
  const chips = $$("#rec-types .chip", area);
  const setType = (t) => { type = t; chips.forEach((c) => c.classList.toggle("on", c.dataset.t === t)); };
  chips.forEach((c) => c.addEventListener("click", () => setType(c.dataset.t)));
  setType("work");

  $("#rec-save", area).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
        const title = ($("#rec-title", area).value || "").trim() || defaultTitle;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await saveRecording({ blob: out.blob, duration: out.duration, mime: out.mime, name: out.name, title, type, speechSec: out.speechSec });
      toast("저장했습니다");
      done();
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      btn.textContent = "다시 저장";
      toast("저장 실패: " + (err.message || "오류"));
    }
  });
}

function recInfo(out) {
  const bits = [];
  if (out?.vad && out.speechSec != null) {
    bits.push(`말한 구간 ${fmtClock(out.speechSec)} / 전체 ${fmtClock(out.duration || 0)}`);
  }
  bits.push(hasGemini() ? "Gemini 키가 있어 이 기기에서 바로 전사합니다" : "저장 후 맥이 전사합니다 (보통 몇 분~다음 실행)");
  return bits.join(" · ");
}

async function saveRecording({ blob, duration, mime, name, title, type, speechSec }) {
  const ext = extFor(mime || blob.type, name || "");
  const base = `${stamp()}_${type}_${uid(6)}`;
  const fileName = `${base}.${ext}`;
  const meta = {
    schema: "hemory.transcript.v1",
    id: base,
    title,
    type,
    started_at: new Date(Date.now() - (duration || 0) * 1000).toISOString(),
    duration_sec: Math.round(duration || 0),
    speech_sec: speechSec != null ? Math.round(speechSec) : undefined,
    source: "web",
    status: "pending",
    language: "ko",
    summary: {},
    speakers: [],
    segments: [],
    created_at: new Date().toISOString(),
  };

  if (S.mode !== "live") {
    toast("데모에서는 저장되지 않습니다");
    return;
  }

  // 1) 즉시 전사 (Gemini 키 + 18MB 이하)
  if (hasGemini() && blob.size < 18 * 1024 * 1024) {
    try {
      const data = await geminiTranscribe(blob, { hint: `제목: ${title} / 유형: ${type}` });
      Object.assign(meta, {
        title: data.title || title,
        type: TYPES[data.type] ? data.type : type,
        summary: {
          one_line: data.one_line || "",
          bullets: data.bullets || [],
          agenda: data.agenda || [],
          decisions: data.decisions || [],
          actions: data.actions || [],
          keywords: data.keywords || [],
        },
        speakers: data.speakers || [],
        segments: data.segments || [],
        status: "done",
        engine: { asr: "gemini", model: CONFIG.geminiModel, summarized_by: "gemini" },
      });
    } catch (e) {
      console.warn("quick transcribe failed", e);
      toast("기기 전사 실패 → 맥 전사로 넘깁니다");
    }
  }

  const parent = meta.status === "done" ? await drive.monthFolder() : await drive.inbox();
  const audioFile = await uploadWithRetry(blob, fileName, parent, mimeFor(ext));
  meta.audio = { file_id: audioFile.id, file_name: fileName, size: blob.size };

  await drive.upload(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), `${base}.json`, parent, { mimeType: "application/json" });

  S.records.unshift(normalizeRecord(meta, { id: audioFile.id + "-json", name: `${base}.json`, modifiedTime: new Date().toISOString(), base, folderName: "" }, { id: audioFile.id, name: fileName }));
  reindex();
  renderTimeline();
  setTimeout(() => syncNow(), 800);
}

async function uploadWithRetry(blob, fileName, parent, mime) {
  try {
    return await drive.upload(blob, fileName, parent, { mimeType: mime });
  } catch (e) {
    // 오프라인: 기기에 보관했다가 다음 연결 때 재시도
    await store.pendingPut({ id: fileName, blob, name: fileName, parent, mime, at: Date.now(), title: fileName });
    throw new Error("네트워크 문제로 기기에 보관했습니다. 연결되면 다시 올라갑니다.");
  }
}

async function uploadTranscriptForExisting(rec, data, blob) {
  const root = await drive.ensureRoot();
  const parent = await drive.monthFolder();
  const base = rec.base || rec.id;
  const meta = {
    schema: "hemory.transcript.v1",
    id: base,
    title: data.title || rec.title,
    type: TYPES[data.type] ? data.type : rec.type,
    started_at: rec.started_at,
    duration_sec: Math.round(data.segments?.length ? Math.max(...data.segments.map((s) => s.end || s.start)) : rec.duration_sec || 0),
    source: rec.source,
    status: "done",
    language: "ko",
    summary: {
      one_line: data.one_line || "", bullets: data.bullets || [], agenda: data.agenda || [],
      decisions: data.decisions || [], actions: data.actions || [], keywords: data.keywords || [],
    },
    speakers: data.speakers || [],
    segments: data.segments || [],
    audio: { file_id: rec.audioId, file_name: rec.audioName },
    engine: { asr: "gemini", model: CONFIG.geminiModel, device: "browser" },
  };
  await drive.upload(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), `${base}.json`, parent, { mimeType: "application/json" });
  // 원본이 _inbox 에 있으면 월 폴더로 이동
  if (rec.folderName === CONFIG.inboxFolder && rec.audioId) {
    await drive.req(`/files/${rec.audioId}?addParents=${parent}&removeParents=${rec.folderId || ""}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }
}

/* ────────────────────────────────── 예약 녹음 · 유실 방지 ── */
function renderAutoBar() {
  const bar = $("#auto-bar");
  if (!bar) return;
  if (!S.auto.on) { bar.hidden = true; bar.innerHTML = ""; bar.classList.remove("show"); return; }
  const now = new Date();
  const d = getSchedule().days[DAY_KEYS[now.getDay()]] || {};
  const el = (Date.now() - S.auto.startedAt) / 1000;
  const speech = S.recorder.speechSec || 0;
  bar.hidden = false;
  bar.classList.add("show");
  bar.innerHTML = `<span class="ab-dot"></span>
    <div class="ab-main"><b>예약 녹음 중</b>
      <span>${esc(d.start || "")}~${esc(d.end || "")} · ${fmtClock(el)} · 말한 구간 ${fmtClock(speech)}</span></div>
    <button class="ab-stop" id="ab-stop">종료</button>`;
  $("#ab-stop", bar).addEventListener("click", () => stopAutoRecording({ reason: "manual" }));
}

async function startAutoRecording(day) {
  if (S.mode !== "live" || S.auto.on || S.auto.pending) return false;
  if (S.recorder.state !== "idle") return false;
  S.auto.pending = true;
  try {
    await S.recorder.start({ vad: localSettings().vad !== false });
  } catch (e) {
    // iOS 는 사용자 조작 없이는 마이크를 열지 못할 때가 있다 → 화면을 한 번 탭하면 다시 시도
    console.warn("auto start blocked", e);
    S.auto.pending = false;
    S.auto.failAt = Date.now();
    armGestureRetry();
    return false;
  }
  S.auto.pending = false;
  S.auto.failAt = 0;
  S.auto.on = true;
  S.auto.startedAt = Date.now();
  S.auto.type = getSchedule().type || "work";
  haptic(12);
  clearInterval(S.auto.timer);
  S.auto.timer = setInterval(renderAutoBar, 1000);
  renderAutoBar();
  toast(`예약 녹음을 시작했습니다${day?.start ? ` (${day.start}~${day.end})` : ""}`);
  return true;
}

async function stopAutoRecording({ reason = "end" } = {}) {
  if (!S.auto.on) return;
  clearInterval(S.auto.timer);
  S.auto.timer = null;
  const out = await S.recorder.stop();
  S.auto.on = false;
  renderAutoBar();
  if (!out || !out.blob?.size) return;
  const title = `예약 녹음 ${fmtTime(new Date().toISOString())}`;
  try {
    await saveRecordingFast({ blob: out.blob, duration: out.duration, mime: out.mime, title, type: S.auto.type || "work", speechSec: out.speechSec });
    toast(reason === "end" ? "예약 시간이 끝나 자동 저장했습니다" : "예약 녹음을 저장했습니다");
  } catch (e) {
    toast("기기에 보관했습니다 · 연결되면 올라갑니다");
  }
}

function schedTick() {
  if (S.mode !== "live") return;
  const day = scheduleActiveNow();
  if (day && !S.auto.on && !S.auto.pending && Date.now() - (S.auto.failAt || 0) > 60000) startAutoRecording(day);
  else if (!day && S.auto.on) stopAutoRecording({ reason: "end" });
}

function armGestureRetry() {
  if (S.auto.gestureBound) return;
  S.auto.gestureBound = true;
  const retry = () => {
    document.removeEventListener("pointerdown", retry, true);
    document.removeEventListener("keydown", retry, true);
    S.auto.gestureBound = false;
    S.auto.failAt = 0;
    schedTick();
  };
  document.addEventListener("pointerdown", retry, true);
  document.addEventListener("keydown", retry, true);
}

/* 화면이 가려지기 직전까지 모인 오디오를 잃지 않게 저장한다 */
let _rescueBusy = false;
async function rescueRecording(reason = "hidden") {
  const R = S.recorder;
  if (R.state !== "recording" && R.state !== "paused") return;
  if (_rescueBusy) return;
  _rescueBusy = true;
  try {
    const wasAuto = S.auto.on;
    clearInterval(S.auto.timer);
    S.auto.timer = null;
    const out = await R.stop();
    S.auto.on = false;
    S.face.active = false;
    hideSleepOverlay();
    renderAutoBar();
    if (S.sheet?._rec) closeSheet();
    if (!out || !out.blob?.size) return;
    const title = wasAuto
      ? `예약 녹음 ${fmtTime(new Date().toISOString())}`
      : `자동 저장 ${fmtTime(new Date().toISOString())}`;
    await saveRecordingFast({ blob: out.blob, duration: out.duration, mime: out.mime, title, type: wasAuto ? S.auto.type : "work", speechSec: out.speechSec });
  } catch (e) {
    console.warn("rescue save failed", reason, e);
  } finally {
    _rescueBusy = false;
  }
}

/* 기기 큐에 먼저 넣고, 이어서 드라이브 업로드를 시도한다(성공하면 큐에서 제거) */
async function saveRecordingFast({ blob, duration, mime, title, type = "work", speechSec }) {
  if (S.mode !== "live") throw new Error("데모에서는 저장되지 않습니다");
  const ext = extFor(mime || blob.type, "");
  const base = `${stamp()}_${type}_${uid(6)}`;
  const fileName = `${base}.${ext}`;
  const mimeType = mimeFor(ext);
  let parent = null;
  try { parent = await drive.inbox(); } catch {}
  // 1) 로컬 큐(IndexedDB)에 먼저 보관 — 화면이 가려져도 유실되지 않게
  try {
    await store.pendingPut({ id: fileName, blob, name: fileName, parent, mime: mimeType, at: Date.now(), title, type, duration, speechSec });
  } catch (e) { console.warn("queue failed", e); }
  // 2) 드라이브 업로드 시도
  if (parent) {
    await drive.upload(blob, fileName, parent, { mimeType });
    await store.pendingDel(fileName).catch(() => {});
  }
  syncNow().catch(() => {});
  return fileName;
}

/* 대기 중 업로드 재시도 */
async function flushPending() {
  if (S.mode !== "live") return;
  let items = [];
  try { items = await store.pendingAll(); } catch { return; }
  for (const it of items) {
    try {
      const parent = it.parent || await drive.inbox();
      await drive.upload(it.blob, it.name, parent, { mimeType: it.mime });
      await store.pendingDel(it.id);
    } catch { break; }
  }
}

/* ────────────────────────────────── 홈 화면 추가 안내 ── */
function maybeShowInstallTip() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const box = $("#tl-tip");
  if (!box || standalone || localStorage.getItem("hemory.installTip") === "1") return;
  box.innerHTML = `<div class="install-tip">
      <div style="flex:1">홈 화면에 추가하면 앱처럼 열립니다.<span>Safari 공유 → 홈 화면에 추가</span></div>
      <button class="x" id="tip-x" aria-label="닫기">✕</button>
    </div>`;
  $("#tip-x", box).addEventListener("click", () => { localStorage.setItem("hemory.installTip", "1"); box.innerHTML = ""; });
}

/* ── 실행 ── */
boot().catch((e) => {
  console.error(e);
  showScreen("gate");
  toast("시작 중 오류: " + (e.message || e));
});
