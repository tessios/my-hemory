/* Hemory 개인용 — 앱 셸, 화면, 동기화, 재생 */
import { CONFIG, TYPES } from "./config.js";
import { drive, AuthError } from "./drive.js";
import { store } from "./store.js";
import { buildIndex, search as doSearch, evidence, keywords, highlight } from "./search.js";
import { ask as askGemini, transcribe as geminiTranscribe, hasGemini } from "./qa.js";
import { Recorder, pickAudioFile, extFor, mimeFor, probeDuration, prewarmMic, unlockAudio, acquireMic, releaseMic, micStatus, onMicChange, markBackgrounded, resumeMicAfterBackground, micPermissionState, micEverAllowed, micMeterRead } from "./record.js";
import { FlipWatcher } from "./flip.js";
import { flipBootPlan, resumePlan, RESUME_GAP_MS } from "./flow.js";
import {
  previewLine, segmentRangeLabel, segmentDue, groupTranscript, silentVerdict, recordSegmentLabel, SEGMENT_SEC,
  timelineFlow, weekDays, dateKeyOf, blockRangeLabel, CATEGORY_WORD, minutesOf, hhmm,
  autoSyncDue, recordSignature, AUTO_SYNC_TICK_MS,
  scheduleSlotOf, mutedAutoSlot, nextAutoAction,
} from "./pure.js";
import { sensorResumePlan, sensorQuietLabel, SENSOR_QUIET_MS, autoMicPlan, micGuide, queueDue } from "./lifecycle.js";
import {
  $, $$, esc, fmtClock, fmtDuration, fmtDay, fmtTime, dayKey, fmtMoment,
  toast, haptic, debounce, uid, stamp, localSettings, saveSettings,
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
  day: dateKeyOf(new Date()),                 // 타임라인이 보여 주는 날
  auto: { on: false, pending: false, stopping: false, failAt: 0, startedAt: 0, type: "work", timer: null, gestureBound: false },
  sel: { on: false, ids: new Set() },          // 타임라인 선택 모드
  seg: { index: 0, startAt: 0, timer: null, type: "work", rotating: null },  // 30분 세그먼트
  segSession: null,                            // 로컬 적립 중인 녹음 세션 메타
  mic: { warn: false, denied: false, nextTry: 0, armed: false, resumeAt: 0, guideShown: false, trying: false },   // 마이크 연결 유지 감시
  queue: { count: 0, fails: 0, lastTry: 0, busy: false },   // 드라이브 업로드 재전송 큐
  week: [],                                    // 현재 주간 바
  resume: { armed: false, kind: "", type: "work", at: 0 },   // 앱을 나갔다 돌아와 이어서 녹음할 대기
  res: { on: false, type: "work", startedAt: 0, title: "" },  // 이어서 녹음(세션 연결) 중
  recSheet: null,                              // 열려 있는 녹음 시트
  recStop: null,                               // 그 시트의 정지·저장 핸들러
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

/* ── 예약 슬롯 억제(v1.6.2) ───────────────────────────
   사용자가 예약 녹음 [종료]를 직접 누르면 그 슬롯이 끝날 때까지 자동으로 다시 켜지 않는다.
   예전에는 종료 후 20초 틱·화면 복귀에서 schedTick 이 즉시 다시 켜서 '종료가 안 먹히는' 것처럼 보였다. */
function autoMute() {
  const m = localSettings().autoMute;
  return m && typeof m === "object" ? m : null;
}
function autoMutedNow(now = new Date()) {
  const slot = scheduleSlotOf(now, scheduleActiveNow(now));
  return !!slot && mutedAutoSlot(autoMute(), slot.id, now.getTime());
}
function setAutoMute(slot) {
  if (!slot) return;
  saveSettings({ autoMute: { slot: slot.id, until: slot.until, at: Date.now() } });
}
/* 예약 설정을 바꾸면 억제를 풀어 새 설정대로 동작하게 한다 */
function clearAutoMute() {
  if (autoMute()) saveSettings({ autoMute: null });
}

/* 녹음 상태가 바뀔 때마다 화면 조각들을 다시 그린다 */
const recListeners = new Set();
function recStatus() {
  for (const fn of recListeners) { try { fn(); } catch (e) { console.warn(e); } }
}
function addRecListener(fn) { recListeners.add(fn); return fn; }
function delRecListener(fn) { recListeners.delete(fn); }

/* ── 뒤집어서 자동 녹음(Face-Down) ─────────────────────
   감지·권한은 js/flip.js 의 FlipWatcher 가 맡고, 여기서는 녹음 시작/정지와 화면만 다룬다. */
S.face = { active: false, startedAt: 0, timer: null, pending: false };

const flip = new FlipWatcher({
  onStart: () => startFaceRecording(),
  onStop: () => stopFaceRecording(true),
  onState: () => { renderFlipChip(); },
  onSample: () => { paintFlipReadout(); },
});
S.flip = flip;

function faceDownPref() { return localSettings().faceDown === true; }

/* 스위치 상태를 저장하고 감시를 켜고 끈다 */
function setFaceDown(on, { prewarm = false } = {}) {
  saveSettings({ faceDown: !!on });
  flip.setArmed(!!on);
  if (on) {
    if (prewarm) { prewarmMic(); unlockAudio(); ensureMicStandby(); }
    flip.ensure();                 // 감시가 꺼져 있었으면 다시 건다(v1.5.1)
  } else {
    flip.disable();
    // 기능을 끄면 마이크도 닫는다(대기 중인 동안에는 계속 열어 두었던 것)
    releaseMic();
    S.mic.warn = false; S.mic.denied = false;
  }
  renderFlipChip();
  return flip.state;
}

/* 앱을 열었을 때·로그인했을 때 저장된 설정으로 뒤집어 녹음을 되살린다(v1.5.1).
   v1.5.0 은 이 복원을 bindGlobal() 끝의 `if (S.mode === "live")` 블록에 두었는데,
   그 시점 S.mode 는 아직 null 이라 한 번도 실행되지 않았다. 그래서 설정에서 스위치를
   켜 둔 사용자도 앱을 새로 열면 armed=false 가 되고, setTab() 의 setProbe(false) 가
   센서 리스너를 꺼 버려 타임라인에서 엎어도 아무 일도 일어나지 않았다. */
function restoreFaceDown() {
  if (S.mode !== "live") return;
  const plan = flipBootPlan({
    pref: faceDownPref(), supported: flip.supported,
    granted: flip.granted, perm: flip.perm, micLive: micStatus().live,
  });
  flip.setArmed(plan.arm);
  if (plan.listen) flip.start();
  else if (plan.ask === "silent") {
    // 이미 허용된 사이트면 프롬프트 없이 granted → 앱을 열자마자 엎기 동작
    flip.requestPermission({ silent: true }).then((r) => {
      if (r.ok) { flip.start(); renderFlipChip(); }
      else if (!flip.granted) armFlipPermission();   // 아니면 첫 탭에서 한 번만
    }).catch(() => armFlipPermission());
  } else if (plan.ask === "none" && plan.arm && !flip.granted && flip.perm !== "denied") {
    armFlipPermission();
  }
  if (plan.warmMic) {
    // v1.7: 앱을 처음 열었을 때도 조용히 한 번 시도한다 — 권한이 남아 있으면 탭 없이 연결된다.
    //   (안 되면 첫 탭에서 열도록 armMicGesture 가 대기한다)
    armMicGesture();
    setTimeout(() => {
      if (S.mode === "live" && faceDownPref() && !micStatus().live) silentMicReconnect("boot");
    }, 600);
  }
  renderFlipChip();
}

/* ── 마이크 연결 유지(v1.4.1) ───────────────────────────────
   한 번 허용한 마이크는 뒤집어 녹음 대기 중에 **계속 열어 둔다**. 그래야 두 번째·세 번째
   엎기에서도 사용자 터치 없이 바로 녹음이 시작된다(iOS 는 캡처가 끊기면 권한을 푼다).
   iOS 가 전화·화면 잠금·백그라운드로 트랙을 끊으면 조용히 다시 열어 보고, 그것도 막히면
   '탭해서 마이크 연결'로 알리고 다음 터치에서 다시 연다. */
/* ── 마이크 자동 재연결 (v1.7) ─────────────────────────────
   사용자 요청: "나갔다가 들어와도 마이크 access 안 눌러도 자동으로 켜지게".
   iOS WebKit 은 getUserMedia 에 제스처를 요구하지 않는다 — 막는 것은 '아직 허용하지
   않은 사이트의 권한 창'이다. 그래서 아래 경우에만 조용히 다시 잡는다.
     · 권한이 이미 granted (permissions.query)
     · 이번 실행에서 열어 둔 대여가 끊김 → 같은 권한으로 재개
     · 한 번이라도 허용한 적이 있고 권한 상태를 알 수 없음(unknown)
   아직 prompt 이고 허용한 적이 없다면 맥락 없이 권한 창을 띄우지 않고 첫 탭을 기다린다.
   (Claude 검토 반영 — pointerdown 은 사용자 제스처로 인정되지 않으므로 실제 획득은
    pointerup·touchend·click 에서 하고, pointerdown 에서는 조용한 시도만 한다) */
async function silentMicReconnect(why = "resume") {
  if (S.mic.trying) return { ok: false, action: "skip" };
  S.mic.trying = true;
  try { return await silentMicReconnectInner(why); }
  finally { S.mic.trying = false; }
}

async function silentMicReconnectInner(why = "resume") {
  if (S.mode !== "live") return { ok: false, action: "none" };
  if (recordingNow()) return { ok: true, action: "keep" };
  const st = micStatus();
  if (st.live) {
    if (S.mic.warn || S.mic.denied) { S.mic.warn = false; S.mic.denied = false; renderFlipChip(); }
    return { ok: true, action: "keep" };
  }
  const permission = await micPermissionState();
  const plan = autoMicPlan({
    permission, held: st.held, live: st.live,
    everAllowed: micEverAllowed(), busy: !recorderIdle(),
  });
  if (plan.action === "keep") return { ok: true, action: "keep" };
  if (plan.action === "skip") return { ok: false, action: "skip" };
  if (plan.action === "denied") {
    S.mic.denied = true; S.mic.warn = false;
    renderFlipChip();
    return { ok: false, action: "denied", reason: "permission-denied" };
  }
  if (plan.action === "gesture") {
    S.mic.denied = false; S.mic.warn = false;
    armMicGesture();
    renderFlipChip();
    return { ok: false, action: "gesture", reason: plan.reason };
  }
  const r = st.held ? await resumeMicAfterBackground() : await acquireMic();
  if (r.ok) {
    const wasWarn = S.mic.warn;
    S.mic.warn = false; S.mic.denied = false;
    renderFlipChip(); paintMicMeter();
    if (wasWarn) toast("마이크를 다시 연결했습니다 · 폰을 엎으면 바로 녹음됩니다", 2200);
    return { ok: true, action: plan.action };
  }
  const denied = r.reason === "denied" || S.mic.denied;
  S.mic.denied = denied;
  S.mic.warn = !denied;
  const guide = micGuide({ reason: r.reason || r.error, permission, everAllowed: micEverAllowed() });
  if (guide && !S.mic.guideShown) { S.mic.guideShown = true; toast(guide, 4200); }
  if (!denied) armMicGesture();
  renderFlipChip();
  return { ok: false, action: "failed", reason: r.reason || "error" };
}

async function ensureMicStandby({ gesture = false, tryAnyway = false } = {}) {
  if (S.mode !== "live") return false;
  if (S.recorder.state === "recording" || S.recorder.state === "paused") return true;
  const st = micStatus();
  if (st.live) {
    if (S.mic.warn || S.mic.denied) { S.mic.warn = false; S.mic.denied = false; renderFlipChip(); }
    return true;
  }
  // 제스처 안이면 곧바로 연다(권한 창도 이 안에서). 아니면 위의 자동 재연결 판단을 따른다.
  if (gesture || tryAnyway) {
    const r = await acquireMic();
    if (r.ok) {
      if (S.mic.warn) toast("마이크를 다시 연결했습니다 · 폰을 엎으면 바로 녹음됩니다", 2400);
      S.mic.warn = false; S.mic.denied = false;
      renderFlipChip(); paintMicMeter();
      return true;
    }
    S.mic.warn = true;
    S.mic.denied = r.reason === "denied";
    const guide = micGuide({ reason: r.reason || r.error, permission: "unknown", everAllowed: micEverAllowed() });
    if (S.mic.denied && guide && !S.mic.guideShown) { S.mic.guideShown = true; toast(guide, 4200); }
    renderFlipChip();
    return false;
  }
  return (await silentMicReconnect("standby")).ok;
}

/* 마지막 녹음 시작 시각 — 상단 바의 '마지막 시작 ...' */
function noteRecordingStart(at = new Date().toISOString()) {
  saveSettings({ lastStart: at });
  paintLastStart();
}
function paintLastStart() {
  const el = $("#last-start");
  if (!el) return;
  const at = localSettings().lastStart || S.records?.[0]?.started_at;
  el.textContent = at ? fmtMoment(at) : "아직 없음";
}

/* ── 앱을 떠났다 돌아오기 (v1.5) ─────────────────────────────
   돌아왔을 때 **다시 묻지 않고** 이어 쓰는 것이 목표다.
   · 마이크: 대여 중인 트랙이 살아 있으면 그대로, 끊겼으면 조용히 다시 연다.
   · 센서: 권한은 페이지 단위라 그대로다 — 리스너만 다시 건다.
   · 녹음 중이었다면: 살아 있으면 계속, 끊겼으면 담긴 데까지 저장한다. */
let _resumeBusy = false;
/* 떠날 때 시작한 '저장 마무리'가 끝날 때까지 잠깐 기다린다.
   복귀가 저장보다 먼저 돌면 recorder 가 아직 recording 이라 이어서 녹음 판단이 틀어진다. */
async function waitForRescue(ms = 4000) {
  const t0 = Date.now();
  while (_rescueBusy && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
}

/* 복귀 처리는 한 번에 하나만 — visibilitychange·pageshow·focus 가 겹쳐 와도
   350ms 동안 하나로 모은다(오디오 세션이 다시 살아날 시간도 준다, Claude 검토 반영). */
let _resumeTimer = null;
function scheduleResume(delay = 350) {
  if (S.mode !== "live") return;
  clearTimeout(_resumeTimer);
  _resumeTimer = setTimeout(() => { _resumeTimer = null; resumeAfterBackground(); }, delay);
}

async function resumeAfterBackground() {
  if (S.mode !== "live" || _resumeBusy) return;
  _resumeBusy = true;
  try {
    await waitForRescue();
    if (document.visibilityState === "hidden") return;
    /* 예약 녹음 판단도 여기서 한 번만 한다 — 예전에는 visibilitychange 가 schedTick 과
       resumeAfterBackground 를 따로 불러, 예약 녹음과 '이어서 녹음'이 동시에 시작될 수 있었다. */
    schedTick();
    if (S.recorder.state === "recording" || S.recorder.state === "paused") {
      await resumeRecordingAfterBackground();
      renderFlipChip();
      refreshQueue();
      return;
    }

    /* 떠날 때 녹음 중이었다면 이어서 녹음(v1.5.1) */
    if (S.resume.armed) {
      // 사용자가 그 예약 슬롯을 직접 꺼 두었으면 이어서 녹음도 시작하지 않는다(v1.6.2)
      if (S.resume.kind === "auto" && autoMutedNow()) S.resume.armed = false;
    }
    if (S.resume.armed) {
      const st = micStatus();
      const perm = await micPermissionState();
      const rp = resumePlan({
        armed: true, gapMs: Date.now() - (S.resume.at || 0),
        micLive: st.live, micMuted: st.muted, perm,
        visible: document.visibilityState === "visible",
        busy: !recorderIdle() || S.auto.on || S.auto.pending || S.face.active || S.res.on,
      });
      if (rp.action === "expire") {
        S.resume.armed = false;
        toast("앱을 나갔던 시간이 길어 이어서 녹음은 마쳤습니다", 2600);
      } else if (rp.action === "auto") {
        await resumeMicAfterBackground();           // 살아 있으면 그대로, 끊겼으면 조용히 다시 연다
        const ok = await startResumedRecording({ type: S.resume.type || "work" });
        if (!ok) armResumeGesture();
        renderFlipChip();
        return;
      } else if (rp.action === "gesture") {
        armResumeGesture();                          // 한 번 탭하면 이어서 시작
      }
    }

    if (faceDownPref() && (flip.armed || flip.probe)) {
      const plan = sensorResumePlan({
        perm: flip.perm, listening: flip.listening, armed: flip.armed, probe: flip.probe,
        hasSignal: flip.hasSignal, quietMs: flip.signalAgeMs,
      });
      if (plan === "restart") flip.resume();
      else if (plan === "need-tap") armFlipPermission();
    }

    if (micStatus().held) {
      const r = await resumeMicAfterBackground();
      if (r.ok) { S.mic.warn = false; S.mic.denied = false; }
      else if (r.action === "gesture") {
        S.mic.denied = r.reason === "denied";
        S.mic.warn = !S.mic.denied;
        if (faceDownPref() && recorderIdle()) armMicGesture();
      }
    } else if (faceDownPref() && recorderIdle()) {
      /* v1.7: 이번 실행에서 아직 연 적이 없거나 iOS 가 페이지를 새로 만들었다.
         권한이 남아 있으면 탭 없이 조용히 다시 잡고, 아니면 첫 탭을 기다린다. */
      const r = await silentMicReconnect("resume");
      if (!r.ok && r.action === "gesture") armMicGesture();
    }

    renderFlipChip();
    paintFlipReadout();
    paintMicMeter();
    refreshQueue();                  // 업로드 대기 항목이 남아 있으면 바로 재전송을 시도한다
    queueTick();
    scheduleSensorQuietCheck();
  } finally { _resumeBusy = false; }
}

async function resumeRecordingAfterBackground() {
  const R = S.recorder;
  if (micStatus().live) {
    try { await R.ctx?.resume?.(); } catch {}
    R.ctxRunning = R.ctx?.state === "running";
    return;
  }
  const r = await resumeMicAfterBackground();
  if (r.ok && micStatus().live) {
    try { await R.ctx?.resume?.(); } catch {}
    R.ctxRunning = R.ctx?.state === "running";
    return;
  }
  await rescueRecording("resume");   // 끊긴 뒤에는 담긴 데까지 저장(빈 파일·깨진 파일 방지)
}

/* 복귀 뒤 센서가 1초 넘게 조용하면 '탭해서 재개'로 안내 */
let _quietTimer = null;
function scheduleSensorQuietCheck() {
  clearTimeout(_quietTimer);
  if (!faceDownPref()) return;
  _quietTimer = setTimeout(() => {
    if (document.visibilityState !== "visible") return;
    if (!(flip.armed || flip.probe) || flip.state === "active") return;
    if (flip.hasSignal) return;
    renderFlipChip();
    const label = sensorQuietLabel({ perm: flip.perm, listening: flip.listening, hasSignal: flip.hasSignal, quietMs: flip.signalAgeMs, armed: flip.armed });
    if (label) toast(`${label} · 아래 칩을 한 번 탭하세요`, 2800);
  }, SENSOR_QUIET_MS + 400);
}

/* 마이크가 끊긴 뒤에는 '다음 터치'에서 다시 연다.
   v1.7: 실제 획득(사용자 제스처)은 pointerup·touchend·click 에서 하고,
   pointerdown 에서는 제스처 없이 되는 경우(권한 granted)를 조용히 다시 시도한다.
   그래서 '마이크 access' 버튼을 다시 누르게 하지 않아도 화면 아무 곳이나 한 번
   만지면 조용히 연결된다. */
function armMicGesture() {
  if (S.mic.armed) return;
  S.mic.armed = true;
  let busy = false;
  const events = ["pointerup", "touchend", "click", "keydown"];
  const armAllowed = () => S.mode === "live" && faceDownPref() && !micStatus().live && recorderIdle();
  const onDown = () => { if (armAllowed()) silentMicReconnect("touch"); };
  const detach = () => {
    S.mic.armed = false;
    events.forEach((t) => document.removeEventListener(t, once, true));
    document.removeEventListener("pointerdown", onDown, true);
  };
  const once = async () => {
    if (busy) return;
    if (S.mode !== "live" || !faceDownPref()) return detach();
    busy = true;
    const ok = await ensureMicStandby({ gesture: true });
    busy = false;
    if (ok) detach();
  };
  events.forEach((t) => document.addEventListener(t, once, true));
  document.addEventListener("pointerdown", onDown, true);
}

/* 앱을 새로 열면 iOS 센서 권한은 다시 한 번 필요하다 → 첫 터치에서 조용히 요청
   iOS 가 '사용자 동작'으로 인정하는 이벤트는 pointerup·touchend·click·keydown 이다
   (pointerdown·touchstart 는 인정되지 않아 권한 요청이 거부될 수 있다).
   성공하기 전에는 리스너를 지우지 않고, 성공하면 정리한다. */
function armFlipPermission() {
  if (S.faceArm) return;
  S.faceArm = true;
  let busy = false;
  const events = ["pointerup", "touchend", "click", "keydown"];
  const detach = () => {
    S.faceArm = false;
    events.forEach((t) => document.removeEventListener(t, once, true));
  };
  const once = async (e) => {
    if (busy) return;
    if (S.mode !== "live" || !faceDownPref()) return detach();
    if (flip.perm === "denied") return detach();
    const t = e?.target;
    if (t?.closest?.("#s-flip-on, #s-flip-perm, #rec-face, #s-flip-test, #flip-chip, #s-flip-mic-btn")) return;
    busy = true;
    // 이 탭(제스처) 안에서 마이크도 먼저 열어 둔다 — iOS 는 제스처 밖 호출을 막는다
    if (!micStatus().live) { try { await prewarmMic(); unlockAudio(); } catch {} }
    if (flip.granted) { busy = false; renderFlipChip(); return detach(); }
    const r = await flip.requestPermission();
    busy = false;
    if (r.ok) {
      flip.start();
      detach();
      toast("뒤집어 녹음 준비됨 · 폰을 엎어 보세요", 1800);
    } else {
      renderFlipChip();
      if (r.reason === "denied") detach();
    }
  };
  events.forEach((t) => document.addEventListener(t, once, true));
}

async function startFaceRecording() {
  if (S.mode !== "live") return false;
  if (S.face.active) return false;
  if (!recorderIdle()) return false;                 // 이미 다른 녹음이 진행 중
  // 녹음 시트가 열려 있어도(대기 상태면) 닫고 시작 — 엎는 순간이 우선이다
  if (S.sheet?._rec) { try { closeSheet(); } catch {} }
  S.face.pending = false;
  S.resume.armed = false;            // 엎어서 시작하면 '이어서 녹음' 대기는 끝난다
  try {
    // 마이크는 한 번 열어 둔 것을 그대로 쓴다(끝나도 닫지 않는다) → 다음 엎기에도 재세팅 없음
    await S.recorder.start({ vad: localSettings().vad !== false, keepMic: true });
  } catch (e) {
    console.warn("face start", e);
    S.face.pending = true;
    S.mic.warn = true;
    S.mic.denied = e?.code === "denied";
    showSleepOverlay("tap");
    armMicGesture();
    toast("마이크를 열지 못했습니다 · 화면을 한 번 탭해 주세요", 3200);
    renderFlipChip();
    return false;
  }
  S.face.active = true;
  S.face.startedAt = Date.now();
  S.face.pending = false;
  noteRecordingStart(new Date(S.face.startedAt).toISOString());
  beginLocalSession({ title: `뒤집어 녹음 ${fmtTime(new Date().toISOString())}`, type: "work" });
  startSegTimer("work", S.face.startedAt);
  if (!flip.active) flip.adopt();     // 탭으로 시작한 경우에도 들면 자동 저장되도록
  haptic(16);
  showSleepOverlay();
  clearInterval(S.face.timer);
  S.face.timer = setInterval(updateSleepOverlay, 1000);
  renderFlipChip();
  return true;
}

/* 이전 녹음이 'done' 상태로 남아 있으면 idle 로 되돌린다 */
function recorderIdle() {
  const R = S.recorder;
  if (R.state === "done") { try { R.cancel(); } catch {} }
  return R.state === "idle";
}

/* ── 한 번 탭해서 바로 녹음(v1.5.1) ────────────────────────────
   상단 '탭하여 듣기 시작'·FAB 를 누르면 시트만 열리던 것을, 누른 그 제스처 안에서
   마이크·오디오·(켜 두었다면) 센서 권한까지 확보하고 **곧바로 녹음을 시작**한다. */
function recordingNow() {
  const st = S.recorder.state;
  return st === "recording" || st === "paused";
}

/* ── 자동 반영 (v1.6) ─────────────────────────────────
   맥이 상주 감시(15초)로 _inbox 를 전사·요약하므로, 앱을 켜 둔 채로도
   "전사 대기" 항목이 곧 실제 기록으로 바뀐다. 5초마다 조건만 보고,
   조건이 맞을 때만 드라이브를 다시 읽는다(녹음 중·화면 가려짐·동기화 중 제외). */
function autoSyncNow({ force = false } = {}) {
  const due = autoSyncDue({
    now: Date.now(),
    lastSync: S.lastSync,
    syncState: S.syncState,
    mode: S.mode,
    visibility: document.visibilityState,
    recording: recordingNow() || S.face.active || S.auto.on || S.res.on || !!S.recSheet,
    records: S.records,
    force,
  });
  if (due) syncNow({ auto: true }).catch(() => {});
}

function startQuickRecording() {
  if (S.auto.on || S.res.on || S.face.active) return toast("녹음 중입니다 · 먼저 종료해 주세요");
  if (!Recorder.supported) return toast("이 브라우저에서는 녹음을 지원하지 않습니다");
  if (S.recSheet) { try { S.recStop?.(); } catch {} return; }   // 이미 열린 시트면 정지
  unlockAudio();                       // 제스처 안에서 AudioContext 를 깨운다
  try { prewarmMic(); } catch {}       // 제스처 안에서 getUserMedia 시작(권한 창도 여기서)
  if (faceDownPref() && !flip.granted && flip.perm !== "denied") {
    // 이 탭이 센서 권한도 함께 받아 둔다 → 다음부터는 엎기만 하면 된다
    flip.requestPermission({ silent: true }).then((r) => { if (r.ok) flip.start(); }).catch(() => {});
  }
  openRecorder({ autoStart: true });
}

function stopQuickRecording() {
  if (S.recSheet && S.recStop) { S.recStop(); return true; }
  if (S.face.active || S.face.pending) { stopFaceRecording(true); return true; }
  if (S.auto.on) { stopAutoRecording({ reason: "manual" }); return true; }
  if (S.res.on) { stopResumedRecording({ reason: "manual" }); return true; }
  return false;
}

/* 상단 바의 상태 — 녹음 중이면 시간이 흐르고, 누르면 정지라고 알린다 */
function paintPill() {
  const pill = $("#btn-listen");
  if (!pill) return;
  const title = $(".lp-title", pill);
  const sub = $(".lp-sub", pill);
  const on = recordingNow() || S.face.active || S.res.on || S.auto.on;
  pill.classList.toggle("on", !!on);
  if (title) {
    title.textContent = on
      ? `녹음 중 ${fmtClock(S.recorder.elapsedSec())} · 탭하여 정지`
      : "탭하여 듣기 시작";
  }
  if (sub) sub.hidden = !!on;
  pill.setAttribute("aria-label", on ? "녹음 정지" : "탭하여 듣기 시작");
  // 녹음 중이라 미뤄 둔 앱 업데이트는 녹음이 끝난 이 순간 적용한다
  if (!on && S.pendingReload) maybeApplyPendingUpdate();
}

/* ── 재생용 오디오 캐시 (같은 파일을 두 번 받지 않게) ── */
const audioCache = new Map();   // fileId → Blob
const audioCacheMax = 12;
function rememberAudio(fileId, blob) {
  if (!fileId || !blob) return;
  if (audioCache.size >= audioCacheMax) {
    const first = audioCache.keys().next().value;
    if (first) audioCache.delete(first);
  }
  audioCache.set(fileId, blob);
}

/* ── 녹음 중 로컬 적립(IndexedDB) ────────────────────────────
   어떤 경우에도 기기에 먼저 남긴다. 앱이 강제 종료되거나 업로드가 실패해도
   다음 실행에서 '복구' 배너로 되살릴 수 있다. */
function beginLocalSession({ title, type }) {
  S.segSession = { id: "s" + Date.now().toString(36), startedAt: Date.now(), title, type };
  store.sessionSet({ ...S.segSession }).catch(() => {});
}
function endLocalSession() {
  const id = S.segSession?.id;
  S.segSession = null;
  if (id) store.partClearGroup(id).catch(() => {});
  store.sessionDel().catch(() => {});
}
function wireRecorder() {
  S.recorder.onPart = (chunk, index) => {
    if (!S.segSession) return;
    store.partPut(`${S.segSession.id}:${String(index).padStart(5, "0")}`, chunk).catch(() => {});
  };
  S.recorder.onSignalAlert = ({ ms, track }) => {
    if (S.recorder.state !== "recording") return;
    const dead = !track || track.readyState !== "live" || track.muted || !track.enabled;
    toast(dead
      ? "마이크 입력이 끊겼습니다 · 폰을 들었다 다시 엎으면 새로 녹음합니다"
      : "마이크 소리가 들어오지 않습니다 · 마이크 구멍이 막혔는지 확인하세요", 4200);
    const hint = $(".so-hint");
    if (hint) hint.textContent = "마이크 신호 없음 · 들었다 다시 엎어 주세요";
    haptic([12, 60, 12]);
    console.warn("mic signal lost", ms, track);
  };
}

/* ── 30분 세그먼트 ─────────────────────────────────────────
   녹음을 끊지 않고(같은 스트림·게이트) MediaRecorder 만 교체해
   30분 블록으로 타임라인에 쌓는다. */
function startSegTimer(type, startedAt = Date.now()) {
  clearInterval(S.seg.timer);
  S.seg.index = 0;
  S.seg.startAt = startedAt;
  S.seg.type = type || "work";
  S.seg.timer = setInterval(() => { segTick().catch(() => {}); }, 1000);
}
function stopSegTimer() {
  clearInterval(S.seg.timer);
  S.seg.timer = null;
}
/* 30분 제한 — 테스트에서만 localStorage(hemory.segTest)로 줄여 검증한다 */
function segLimitSec() {
  try {
    const v = Number(localStorage.getItem("hemory.segTest"));
    if (v >= 2 && v <= 3600) return v;
  } catch {}
  return SEGMENT_SEC;
}
async function segTick() {
  if (S.recorder.state !== "recording") return;
  if (S.auto.stopping || S.seg.rotating) return;      // 종료·회전 중에는 새로 돌리지 않는다
  if (!segmentDue(S.seg.startAt, Date.now(), segLimitSec())) return;
  await segRotate();
}
async function segRotate() {
  if (S.seg.rotating) return;
  const startAt = S.seg.startAt;
  // rotate 는 스트림은 두고 MediaRecorder 만 바꾼다 — 그 사이 stop 이 들어오면
  //   stop 이 이 promise 를 기다렸다가 마무리한다(그래야 새 recorder 가 고아로 남지 않는다).
  const p = S.recorder.rotate();
  S.seg.rotating = p;
  let out = null;
  try { out = await p; } finally { if (S.seg.rotating === p) S.seg.rotating = null; }
  if (!out || !out.blob?.size) return;
  const index = S.seg.index;
  const endAt = Date.now();
  S.seg.index = index + 1;
  S.seg.startAt = endAt;
  const label = segmentRangeLabel(startAt, endAt);
  const verdict = silentVerdict({ maxRms: out.maxRms, durationSec: out.duration, speechSec: out.speechSec, vad: out.vad });
  const title = `${label} 녹음${verdict.silent ? " · 무음" : ""}`;
  try {
    await saveRecordingFast({
      blob: out.blob, duration: out.duration, mime: out.mime, title,
      type: S.seg.type, speechSec: out.speechSec, speechFromSec: out.speechFromSec,
      started_at: new Date(startAt).toISOString(),
      segment: { index, start: new Date(startAt).toISOString(), end: new Date(endAt).toISOString(), label },
    });
    toast(`${label} 구간을 저장했습니다`);
  } catch (e) {
    toast("구간을 기기에 보관했습니다 · 연결되면 올라갑니다", 3200);
  }
  if (verdict.silent) toast("이 구간은 소리가 거의 없었습니다 (마이크 확인)", 3200);
}

/* 녹음 결과에 무음 판정을 붙여 저장 */
async function saveRecordedOut(out, { title, type, startedAt, segment } = {}) {
  const verdict = silentVerdict({ maxRms: out.maxRms, durationSec: out.duration, speechSec: out.speechSec, vad: out.vad });
  const finalTitle = verdict.silent ? `${title} · 무음` : title;
  await saveRecordingFast({
    blob: out.blob, duration: out.duration, mime: out.mime, title: finalTitle,
    type, speechSec: out.speechSec, speechFromSec: out.speechFromSec, started_at: startedAt, segment,
  });
  if (verdict.silent) {
    toast(verdict.reason === "no_signal"
      ? "저장했지만 마이크 소리가 없었습니다 · 마이크를 확인해 주세요"
      : "저장했지만 말소리가 거의 없었습니다", 4200);
  }
  return verdict;
}

async function stopFaceRecording(save = true) {
  const was = S.face.active || S.face.pending;
  if (!was) return;
  S.face.active = false;
  S.face.pending = false;
  S.resume.armed = false;            // 사용자가 직접 멈췄다 → '이어서 녹음' 대기 없음
  clearInterval(S.face.timer);
  S.face.timer = null;
  hideSleepOverlay();
  flip.markStopped();
  renderFlipChip();
  stopSegTimer();
  if (S.recorder.state === "idle") return;
  const segIndex = S.seg.index;
  const segStart = S.seg.startAt || S.face.startedAt;
  const out = await S.recorder.stop();
  if (!save || !out || !out.blob?.size) { endLocalSession(); return; }
  const endAt = Date.now();
  const label = segmentRangeLabel(segStart, endAt);
  const title = segIndex === 0
    ? `뒤집어 녹음 ${fmtTime(new Date(segStart).toISOString())}`
    : `${label} 녹음`;
  try {
    await saveRecordedOut(out, {
      title, type: "work",
      startedAt: new Date(segStart).toISOString(),
      segment: { index: segIndex, start: new Date(segStart).toISOString(), end: new Date(endAt).toISOString(), label },
    });
    endLocalSession();
    haptic([10, 40, 10]);
    toast("녹음을 저장했습니다");
  } catch (e) {
    // 기기(IndexedDB)에는 이미 남아 있다 — 다음 실행에서 복구할 수 있다
    toast("기기에 보관했습니다 · 연결되면 올라갑니다");
  }
}

/* ── 앱을 나갔다 돌아와 이어서 녹음(v1.5.1) ──────────────────────
   iOS 는 앱을 전환하면 오디오 캡처를 멈추기 때문에, 떠날 때 그때까지를 저장하는 것은 맞다.
   문제는 돌아와도 다시 시작하지 않아 녹음이 끊긴 채로 끝나던 것.
   이제 떠날 때 '이어서 녹음' 의사를 기억해 두고, 돌아오면
     · 대여한 마이크 트랙이 살아 있으면 사용자 터치 없이 바로(new MediaRecorder),
     · 권한은 있는데 트랙이 끝났으면 조용히 다시 열어서,
     · 그래도 막히면 한 번 탭으로 이어서 시작한다. */
function renderResBar() {
  const bar = $("#resume-bar");
  if (!bar) return;
  if (!S.res.on) { bar.hidden = true; bar.innerHTML = ""; bar.classList.remove("show"); return; }
  const el = (Date.now() - S.res.startedAt) / 1000;
  bar.hidden = false;
  bar.classList.add("show");
  bar.innerHTML = `<span class="ab-dot"></span>
    <div class="ab-main"><b>이어서 녹음 중</b>
      <span>${fmtClock(el)} · 앱을 다녀온 뒤에도 계속 담고 있습니다</span></div>
    <button class="ab-stop" id="res-stop">저장</button>`;
  $("#res-stop", bar).addEventListener("click", () => stopResumedRecording({ reason: "manual" }));
}

async function startResumedRecording({ type = "work" } = {}) {
  if (S.mode !== "live" || S.res.on || !recorderIdle()) return false;
  try {
    await S.recorder.start({ vad: localSettings().vad !== false, keepMic: true });
  } catch (e) {
    console.warn("resume start", e);
    S.resume.armed = true;            // 탭 한 번으로 이어서 시작
    armResumeGesture();
    toast("이어서 녹음하려면 화면을 한 번 탭해 주세요", 3200);
    return false;
  }
  S.resume.armed = false;
  S.res.on = true;
  S.res.type = TYPES[type] ? type : "work";
  S.res.startedAt = Date.now();
  noteRecordingStart(new Date(S.res.startedAt).toISOString());
  beginLocalSession({ title: `이어서 녹음 ${fmtTime(new Date().toISOString())}`, type: S.res.type });
  startSegTimer(S.res.type, S.res.startedAt);
  haptic(12);
  clearInterval(S.res.timer);
  S.res.timer = setInterval(renderResBar, 1000);
  renderResBar();
  toast("이어서 녹음 중입니다", 2000);
  return true;
}

async function stopResumedRecording({ reason = "end" } = {}) {
  if (!S.res.on) return;
  clearInterval(S.res.timer);
  S.res.timer = null;
  stopSegTimer();
  const segIndex = S.seg.index;
  const segStart = S.seg.startAt || S.res.startedAt;
  const out = await S.recorder.stop();
  S.res.on = false;
  S.resume.armed = false;
  renderResBar();
  if (!out || !out.blob?.size) { endLocalSession(); return; }
  const endAt = Date.now();
  const label = segmentRangeLabel(segStart, endAt);
  try {
    await saveRecordedOut(out, {
      title: segIndex === 0 ? `이어서 녹음 ${fmtTime(new Date(segStart).toISOString())}` : `${label} 녹음`,
      type: S.res.type || "work",
      startedAt: new Date(segStart).toISOString(),
      segment: { index: segIndex, start: new Date(segStart).toISOString(), end: new Date(endAt).toISOString(), label },
    });
    endLocalSession();
    haptic([10, 40, 10]);
    toast(reason === "end" ? "이어서 담은 녹음을 저장했습니다" : "녹음을 저장했습니다");
  } catch {
    toast("기기에 보관했습니다 · 연결되면 올라갑니다");
  }
}

/* 한 번 탭으로 이어서 녹음 — 마이크가 막혔을 때의 정상 경로다 */
function armResumeGesture() {
  if (S.resArm) return;
  S.resArm = true;
  const events = ["pointerup", "touchend", "click", "keydown"];
  const detach = () => { S.resArm = false; events.forEach((t) => document.removeEventListener(t, once, true)); };
  const once = async () => {
    if (!S.resume.armed) return detach();
    if (S.mode !== "live") return detach();
    const ok = await ensureMicStandby({ gesture: true });
    if (!ok) return;
    detach();
    await startResumedRecording({ type: S.resume.type || "work" });
  };
  events.forEach((t) => document.addEventListener(t, once, true));
}

function showSleepOverlay(mode) {
  const el = $("#sleep-overlay");
  if (!el) return;
  const hint = $(".so-hint", el);
  if (hint) hint.textContent = mode === "tap" ? "화면을 한 번 탭하면 녹음을 시작합니다" : "들면 자동으로 저장합니다";
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  updateSleepOverlay();
}

function hideSleepOverlay() {
  const el = $("#sleep-overlay");
  if (!el) return;
  el.classList.remove("show");
  el.hidden = true;
  S.face.pending = false;
}

function updateSleepOverlay() {
  const el = $("#sleep-overlay");
  if (!el || el.hidden) return;
  const t = $("#so-time", el);
  if (t) {
    t.textContent = S.face.active
      ? fmtClock((Date.now() - S.face.startedAt) / 1000)
      : S.face.pending ? "—" : fmtClock(0);
  }
  /* v1.5.2 — 화면 꺼짐 방지가 안 걸린 채로 녹음 중이면(아이폰 홈화면 앱 iOS 18.4 미만·저전력 모드)
     자동 잠금으로 화면이 꺼지는 순간 iOS 가 마이크를 끊는다. 검은 화면에는 이 경고밖에 보이지 않는다. */
  const hint = el.querySelector(".so-hint");
  if (hint) {
    const warn = S.face.active && Recorder.wakeSupported && S.recorder.wake !== "held";
    hint.textContent = warn
      ? "화면이 꺼지면 녹음이 끊깁니다 · 설정 > 화면 자동 잠금 '안 함'"
      : "들면 자동으로 저장합니다";
    hint.classList.toggle("warn", !!warn);
  }
  renderFlipChip();
}

/* 타임라인 위의 '뒤집어 녹음' 상태 칩 — 지금 켜져 있는지/권한이 필요한지 보이게 */
function renderFlipChip() {
  const el = $("#flip-chip");
  if (!el) return;
  const show = S.mode === "live" && S.tab !== "settings" && !S.auto.on && (faceDownPref() || flip.state === "active");
  el.hidden = !show;
  if (!show) return;
  el.dataset.state = flip.state;
  const m = micStatus();
  el.dataset.mic = flip.state === "active" || m.live ? "live" : S.mic.denied || m.state === "denied" ? "denied" : "lost";
  let label = flip.state === "need-tap" && flip.perm === "unknown" ? "탭해서 센서 연결" : flip.label;
  // 센서는 준비됐는데 마이크가 없다면 그 사실을 먼저 알린다(v1.4.1)
  if (flip.state !== "active" && faceDownPref() && !m.live) {
    label = S.mic.denied || m.state === "denied" ? "마이크 권한 차단됨 · 설정에서 허용"
      : micEverAllowed() ? "마이크 연결 대기 · 화면을 한 번 탭"
      : "탭해서 마이크 연결";
  }
  const t = flip.state === "active" ? ` · ${fmtClock(flip.elapsedSec)}` : "";
  /* v1.7: 마이크를 들고 있는 동안은 5칸 레벨 미터를 함께 보여, 대기 중에도 마이크가
     실제로 소리를 받고 있는지 즉시 확인할 수 있게 한다(0을 무음으로 오탐하지 않는다). */
  const meter = m.held ? `<span class="fc-meter" id="fc-meter" data-s="${m.live ? "live" : "wait"}" aria-hidden="true">${Array.from({ length: 5 }, () => "<i></i>").join("")}</span>` : "";
  el.innerHTML = `<span class="fc-dot"></span><span>뒤집어 녹음 · ${esc(label)}${t}</span>${meter}`;
  paintMicMeter();
}

/* 대기 중 마이크 레벨 — 5칸 막대. 상태가 '측정 대기'면 막대를 비워 0을 무음으로 보이지 않게 한다. */
function paintMicMeter() {
  const el = $("#fc-meter");
  if (!el) return;
  if (document.visibilityState !== "visible") return;
  const st = micStatus();
  if (!st.held) { el.hidden = true; return; }
  el.hidden = false;
  const m = micMeterRead();
  el.dataset.s = m.state;
  const level = Math.min(1, Math.sqrt(Math.max(0, m.rms || 0) * 26));
  const bars = $$("i", el);
  bars.forEach((b, i) => {
    const on = m.state === "live" && level >= (i + 1) / (bars.length + 0.6);
    b.classList.toggle("on", on);
  });
  el.title = m.state === "waiting" ? "마이크 레벨 측정 대기 · 화면을 한 번 탭하면 확인합니다"
    : m.state === "nosignal" ? "마이크 신호가 없습니다"
    : m.state === "silent" ? "마이크 연결됨 · 지금은 조용합니다"
    : m.state === "interrupted" ? "마이크가 잠시 끊겼습니다 · 곧 다시 연결합니다"
    : m.state === "lost" ? "마이크 연결이 끊겼습니다"
    : "마이크 연결됨";
}

/* 설정 화면의 실시간 센서 표시 */
let _flipPaintAt = 0;
function paintFlipReadout(force = false) {
  const body = $("#settings-body");
  if (!body) return;
  const nowEl = $("#s-flip-now", body);
  if (!nowEl) return;
  const now = Date.now();
  if (!force && now - _flipPaintAt < 180) return;
  _flipPaintAt = now;
  const beta = flip.last.beta, gz = flip.last.gz;
  const has = flip.hasSignal;
  nowEl.textContent = has
    ? `${flip.poseLabel} · β ${beta == null ? "—" : Math.round(beta)}° · z ${gz == null ? "—" : gz.toFixed(1)}`
    : (flip.granted ? "센서 값을 기다리는 중…" : "센서 권한을 허용하면 값이 보입니다");
  const verdict = $("#s-flip-verdict", body);
  if (verdict) {
    verdict.dataset.pose = flip.pose;
    verdict.textContent = flip.active ? "녹음 중입니다"
      : flip.pose === "down" ? "엎임 — 이 상태가 1.5초 이어지면 녹음이 시작됩니다"
      : flip.pose === "up" ? "화면이 위 — 폰을 엎어 보세요"
      : flip.pose === "tilt" ? "들고 있는 상태 — 책상에 엎어 두세요"
      : "센서 신호를 기다리는 중";
  }
  const permEl = $("#s-flip-perm", body);
  if (permEl) {
    permEl.textContent = flip.perm === "denied" ? "차단됨"
      : flip.granted ? (flip.hasSignal ? "허용됨 · 신호 정상" : "허용됨") : "확인 필요";
  }
  const micEl = $("#s-flip-mic", body);
  if (micEl) {
    const m = micStatus();
    const denied = S.mic.denied || m.state === "denied";
    micEl.dataset.mic = m.live ? "live" : denied ? "denied" : "lost";
    micEl.textContent = m.live ? "연결됨 · 대기 중에도 열어 둠"
      : denied ? "차단됨 · 폰 설정에서 허용"
      : m.state === "interrupted" ? "끊김 · 다시 연결 중"
      : m.state === "lost" ? "끊김 · 탭해서 다시 연결"
      : "아직 열지 않음";
  }
}


/* ────────────────────────────────── 시작 ── */
async function boot() {
  drive.init();
  // iOS 가 저장소를 임의로 비우지 않게(청크 복구 데이터 보호)
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}
  $("#app-version").textContent = CONFIG.version;

  let redirect = { ok: false };
  try { redirect = drive.consumeRedirect() || { ok: false }; } catch {}

  bindGlobal();
  // 첫 실행: 권한이 이미 있으면 조용히 한 번 시도해 본다(성공하면 무터치로 준비)
  setTimeout(() => { if (faceDownPref() && !flip.granted && S.mode === "live") armFlipPermission(); }, 1200);

  const notice = (() => { try { return localStorage.getItem("hemory.authNotice") || ""; } catch { return ""; } })();
  if (notice) {
    try { localStorage.removeItem("hemory.authNotice"); } catch {}
    setTimeout(() => toast(notice, 4500), 500);
  }

  // ?demo=1 — 로그인 없이(또는 로그인 상태에서도) 가상 데모로 둘러보기
  if (new URLSearchParams(location.search).get("demo") === "1") { enterDemo(); return; }

  // 한 번이라도 로그인했다면 토큰이 만료돼도 첫 화면으로 돌아가지 않는다.
  if (drive.hasSession) {
    enterLive();
    if (redirect.ok) toast(redirect.silent ? "Google 연결을 자동으로 갱신했습니다" : "Google 계정에 연결했습니다", 1800);
    else if (redirect.error) showConnBar();
    return;
  }

  showScreen("gate");
  if (!drive.configured) $("#btn-signin").textContent = "처음 설정이 필요합니다";
}

/* 녹음 중이거나 시트가 열려 있으면 Google로 화면을 넘기지 않는다 */
function canLeaveApp() {
  if (S.recorder.state !== "idle") return false;
  if (S.face.active || S.auto.on || S.res.on) return false;
  if (S.sheet?._rec) return false;
  if ($("#sheet-root").querySelector(".sheet")) return false;
  if (document.visibilityState !== "visible") return false;
  return true;
}

/* ── 연결 상태 막대 ───────────────────────── */
function showConnBar() {
  const el = $("#conn-bar");
  if (!el || S.mode !== "live") return;
  el.hidden = false;
}
function hideConnBar() {
  const el = $("#conn-bar");
  if (el) el.hidden = true;
}

/* 앱으로 돌아왔을 때: 토큰이 죽어 있으면 조용한 갱신을 한 번 시도 */
function resumeConnection() {
  if (S.mode !== "live" || !drive.hasSession) return;
  if (drive.tokenValid) { hideConnBar(); return; }
  drive.ensureToken()
    .then(() => { hideConnBar(); if (S.mode === "live") syncNow(); })
    .catch((e) => { if (e?.code === "needs_reconnect") showConnBar(e.code); });
}

async function reconnect() {
  hideConnBar();
  try {
    toast("Google 연결을 확인합니다…");
    await drive.signIn({ interactive: true });
    if (drive.signedIn) {
      toast("연결되었습니다");
      syncNow({ manual: true });
    }
  } catch (e) {
    if (e?.code === "cancelled") return;
    toast(e?.message || "다시 연결하지 못했습니다");
    showConnBar();
  }
}

/* ── 앱 버전 확인(v1.5.1) ────────────────────────────────────
   아이폰 홈화면 앱은 서비스워커·HTTP 캐시 때문에 구버전 화면이 남기 쉽다.
   서버의 version.json 과 지금 실행 중인 버전을 직접 대조하고, 다르면
   캐시·서비스워커를 모두 지우고 새 주소로 한 번만 새로 연다. */
let _lastUpdateCheck = 0;
async function checkForUpdate({ force = false, minGapMs = 10 * 60 * 1000 } = {}) {
  if (!force && Date.now() - _lastUpdateCheck < minGapMs) return { updated: false, skipped: true };
  _lastUpdateCheck = Date.now();
  try {
    const res = await fetch(`version.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("no version.json");
    const j = await res.json();
    const latest = String(j.version || "").trim();
    if (!latest || latest === CONFIG.version) return { updated: false, latest: latest || CONFIG.version };
    // 녹음 중에 새로고침하면 담고 있던 소리가 끊긴다 → 끝난 뒤에 바꿔 끼운다
    if (recordingNow() || S.face.active || S.auto.on || S.res.on || S.resume.armed) {
      S.pendingReload = latest;
      if (force) toast("새 버전이 있습니다 · 녹음이 끝나면 자동으로 업데이트합니다", 3200);
      return { updated: false, latest, pending: true };
    }
    toast(`새 버전 v${latest} 로 업데이트합니다`, 2200);
    await hardReloadVersion(latest);
    return { updated: true, latest };
  } catch {
    return { updated: false, error: true };
  }
}

/* 녹음이 끝난 뒤 미뤄 둔 업데이트 적용 */
function maybeApplyPendingUpdate() {
  const v = S.pendingReload;
  if (!v) return;
  if (recordingNow() || S.face.active || S.auto.on || S.res.on || S.resume.armed) return;
  S.pendingReload = null;
  toast("새 버전으로 업데이트합니다", 1800);
  setTimeout(() => { if (v === "sw") location.reload(); else hardReloadVersion(v); }, 900);
}

async function hardReloadVersion(latest) {
  // 같은 버전으로 두 번 새로고침하지 않는다(무한 반복 방지)
  try {
    if (sessionStorage.getItem("hemory.reloadedFor") === latest) {
      toast("업데이트가 적용되지 않았습니다 · 앱을 완전히 닫았다 열어 주세요", 4200);
      return;
    }
    sessionStorage.setItem("hemory.reloadedFor", latest);
  } catch {}
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
  } catch {}
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
    }
  } catch {}
  try {
    const url = new URL(location.href);
    url.searchParams.set("v", latest);
    url.searchParams.set("u", String(Date.now()));
    location.replace(url.toString());
  } catch { location.reload(); }
}

function bindGlobal() {
  drive.canNavigate = canLeaveApp;
  wireRecorder();
  $("#auto-bar")?.addEventListener("click", onAutoBarClick);   // 예약 바는 매초 바뀌므로 위임(v1.6.2)
  $("#conn-bar")?.addEventListener("click", reconnect);
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
  $("#btn-menu")?.addEventListener("click", openMenuSheet);
  $("#btn-listen")?.addEventListener("click", () => {
    // 탭하면 곧바로 녹음 시작(이미 녹음 중이면 정지·저장)
    if (recordingNow() || S.face.active || S.auto.on || S.res.on) { stopQuickRecording(); return; }
    startQuickRecording();
  });
  $("#btn-today")?.addEventListener("click", gotoToday);
  $("#dn-month")?.addEventListener("click", openDayPicker);
  $("#btn-settings-back")?.addEventListener("click", () => setTab("timeline"));
  $("#queue-dot")?.addEventListener("click", () => openQueueSheet());
  $("#fab").addEventListener("click", () => {
    if (recordingNow() || S.face.active || S.auto.on || S.res.on) { stopQuickRecording(); return; }
    startQuickRecording();
  });

  // 에이전트 탭
  $("#ask-run")?.addEventListener("click", async () => {
    const inp = $("#ask-input");
    const q = (inp?.value || "").trim();
    if (!q) { inp?.focus(); return toast("궁금한 것을 적어 주세요"); }
    await askInto($("#ask-body"), q);
  });
  $("#ask-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#ask-run")?.click(); }
  });
  $$("#agent-links .alink").forEach((b) => b.addEventListener("click", () => {
    setTab("settings");
    const id = b.dataset.scroll;
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
  }));

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

  window.addEventListener("online", () => { if (S.mode === "live") { syncNow(); queueTick(true); } });
  /* v1.6.1: 예약·엎기로 제스처 없이 시작한 녹음은 iOS 가 AudioContext 를 잠가
     "말한 구간"이 잡히지 않는다. 앱 안의 첫 탭(제스처)에서 바로 깨우고,
     화면 복귀·앞으로 오기에서도 깨운다(비용이 거의 없고 녹음에는 영향 없음). */
  const wakeRecorderAudio = () => {
    const R = S.recorder;
    if (!R || (R.state !== "recording" && R.state !== "paused")) return;
    try { R.tryResumeAudio?.(); } catch {}
    renderAutoBar();
  };
  document.addEventListener("pointerdown", wakeRecorderAudio, { passive: true });
  document.addEventListener("touchstart", wakeRecorderAudio, { passive: true });
  /* v1.7: 대기 중 마이크 레벨은 이미 깨어 있는 AudioContext 가 있어야 잰다.
     첫 터치(제스처)에서 한 번 깨워 두면 이후 대기 중에도 레벨이 보인다. */
  const unlockOnce = () => {
    try { unlockAudio(); } catch {}
    document.removeEventListener("pointerdown", unlockOnce, true);
    document.removeEventListener("touchend", unlockOnce, true);
    document.removeEventListener("keydown", unlockOnce, true);
  };
  document.addEventListener("pointerdown", unlockOnce, true);
  document.addEventListener("touchend", unlockOnce, true);
  document.addEventListener("keydown", unlockOnce, true);
  if ("serviceWorker" in navigator) {
    let swReloaded = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
      S.swReg = reg;
      reg.addEventListener?.("updatefound", () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) {
            try { reg.waiting?.postMessage({ type: "SKIP_WAITING" }); } catch {}
            toast("새 버전이 준비되어 다시 열겠습니다", 1800);
          }
        });
      });
      reg.update?.().catch(() => {});
      // 주기적으로 새 버전 확인 — 홈화면 앱은 다시 열어도 확인이 늦다
      setInterval(() => {
        if (document.visibilityState !== "visible") return;
        reg.update?.().catch(() => {});
        checkForUpdate().catch(() => {});
      }, 30 * 60 * 1000);
      setTimeout(() => checkForUpdate().catch(() => {}), 3000);
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swReloaded || !hadController) return;
      swReloaded = true;
      // 녹음 중·시트 열림이면 건드리지 않는다 (녹음이 끝난 뒤 반영)
      if (canLeaveApp()) location.reload();
      else S.pendingReload = S.pendingReload || "sw";
    });
  }

  /* 녹음 상태 → 화면 조각들 */
  S.recorder.onStatus = recStatus;
  addRecListener(renderAutoBar);
  addRecListener(updateSleepOverlay);
  addRecListener(paintPill);
  setInterval(paintPill, 1000);      // 상단 바의 녹음 시간

  /* ── 앱을 떠났다 돌아오기 (v1.5) ───────────────────────────
     떠날 때: 녹음 중이면 지금까지를 저장한다(iOS 는 백그라운드에서 캡처를 멈춘다).
     **마이크는 닫지 않는다** — 닫으면 iOS 가 권한을 풀어 복귀 때 다시 묻게 된다.
     돌아올 때: 살아 있으면 아무 것도 하지 않고, 끊겼으면 조용히 복구한다. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      rescueRecording("hidden");
      markBackgrounded();          // 스트림은 그대로 들고 간다(대여 유지)
    } else {
      renderAutoBar(); resumeConnection();
      scheduleResume();
      renderFlipChip();
      paintPill();
      S.swReg?.update?.().catch(() => {});
      checkForUpdate().catch(() => {});     // 새 버전이면 캐시를 지우고 새로 연다
      autoSyncNow({ force: true });         // 돌아오면 바로 최신 전사·요약을 반영한다(v1.6)
      wakeRecorderAudio();                  // 녹음 중이면 잠긴 AudioContext 도 깨운다(v1.6.1)
    }
  });
  window.addEventListener("pagehide", () => { rescueRecording("pagehide"); markBackgrounded(); });
  window.addEventListener("pageshow", (e) => {
    // bfcache·프로세스 재개로 돌아온 경우: 권한을 다시 묻지 않고 감시만 되살린다
    if (!e.persisted) { renderFlipChip(); return; }
    scheduleResume();
    autoSyncNow({ force: true });
  });
  // focus 는 visibilitychange 를 놓치는 경우(데스크톱·안드로이드 브라우저)의 보조 신호
  window.addEventListener("focus", debounce(() => {
    if (document.visibilityState === "visible") { scheduleResume(); autoSyncNow({ force: true }); }
  }, 700));

  /* 절전 오버레이를 탭하면 바로 종료·저장(시작이 막혀 있으면 시작) */
  $("#sleep-overlay")?.addEventListener("click", () => {
    if (S.face.active) stopFaceRecording(true);
    else if (S.face.pending) {
      S.face.pending = false;
      hideSleepOverlay();
      startFaceRecording();
    }
  });

  /* 타임라인의 상태 칩 → 권한이 없으면 바로 재연결(이 탭이 사용자 제스처다), 있으면 설정으로 */
  $("#flip-chip")?.addEventListener("click", async () => {
    if (S.mode !== "live") return;
    if (!faceDownPref()) { setTab("settings"); return; }
    if (!flip.granted) {
      const r = await flip.requestPermission();
      if (r.ok) { flip.start(); toast("센서를 다시 연결했습니다 · 폰을 엎어 보세요", 2000); }
      else toast(r.reason === "denied" ? "센서 권한이 차단되어 있습니다 · 설정에서 허용해 주세요" : "센서 권한을 확인하지 못했습니다", 3200);
      renderFlipChip();
      return;
    }
    if (!flip.listening) { flip.start(); renderFlipChip(); toast("센서 감시를 다시 켰습니다", 1600); return; }
    // 허용된 상태인데 이벤트가 멈춰 있을 때(백그라운드 복귀 등): 이 탭으로 리스너를 다시 걸고 권한을 재확인한다.
    //   이미 허용된 권한이라 프롬프트는 뜨지 않는다.
    if (!flip.hasSignal) {
      await flip.reanimate();
      renderFlipChip();
      setTimeout(() => {
        if (flip.hasSignal) { toast("센서를 다시 붙였습니다 · 폰을 엎어 보세요", 2000); return; }
        setTab("settings");
        setTimeout(() => $("#sgroup-flip")?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
      }, 900);
      return;
    }
    // 마이크가 끊겨 있으면 이 탭으로 바로 다시 연다
    if (!micStatus().live && !S.face.active) {
      const ok = await ensureMicStandby({ gesture: true });
      if (ok) { toast("마이크를 연결했습니다 · 폰을 엎어 보세요", 1800); return; }
    }
    setTab("settings");
    setTimeout(() => $("#sgroup-flip")?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
  });

  /* 예열: 예약 녹음 20초마다 확인, 뒤집어 녹음은 첫 탭에서 센서 권한 */
  setInterval(schedTick, 20000);
  /* v1.7: 업로드 재전송 큐 — 30초마다 조건만 보고(실패할수록 간격을 늘린다) 보낸다 */
  setInterval(() => queueTick(), 30000);
  /* v1.7: 대기 중 마이크 레벨 표시 — 화면이 보일 때만 8Hz로 읽는다 */
  setInterval(() => { if (document.visibilityState === "visible") paintMicMeter(); }, 130);
  /* 자동 반영(v1.6): 5초마다 조건만 보고, 전사·요약 대기 중이면 20초·아니면 30초마다
     드라이브를 다시 읽는다. 녹음 중·화면 가려짐·동기화 중에는 건너뛴다. */
  setInterval(() => autoSyncNow(), AUTO_SYNC_TICK_MS);
  /* 마이크 연결 유지 감시(v1.4.1) — 엎기 대기 중에 트랙이 조용해졌으면 다시 잡는다.
     실패하면 간격을 늘려 iOS 에 권한 질문을 연속으로 던지지 않는다. */
  onMicChange((s) => {
    renderFlipChip(); paintFlipReadout();
    // 마이크가 돌아오면 '들었다 다시 엎어야' 하던 막힘을 풀어 준다(v1.7)
    if (s.live && flip.blockUntilRelease && flip.pose === "down") flip.unblock();
  });
/* 엎어 대기 중 마이크가 조용해지면 다시 잡는다. 녹음 중이거나 화면이 가려져 있으면 건드리지 않는다. */
  setInterval(() => {
    if (S.mode !== "live" || !faceDownPref()) return;
    if (document.visibilityState !== "visible") return;
    if (!recorderIdle()) return;
    if (micStatus().live) return;
    if (Date.now() < (S.mic.nextTry || 0)) return;
    S.mic.nextTry = Date.now() + 8000;
    ensureMicStandby().then((ok) => { if (!ok) S.mic.nextTry = Date.now() + 20000; });
  }, 5000);
  /* 뒤집어 녹음 복원 — 로그인 전(boot)에는 아무 것도 하지 않고, enterLive() 에서 한 번 더 부른다.
     (v1.5.0 은 여기서 S.mode === "live" 를 확인했는데 이 시점에는 항상 null 이었다) */
  restoreFaceDown();
  renderFlipChip();
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
  if (tab === "search") { renderSearch(); }
  if (tab === "people") renderPeople();
  if (tab === "agent") { renderAgent(); setTimeout(() => $("#ask-input")?.focus(), 120); }
  if (tab === "settings") renderSettings();
  else if (typeof flip !== "undefined") {
    flip.setProbe(false);
    // 설정을 켜 둔 채 타임라인·다른 탭으로 오면 감시가 꺼지지 않게 다시 건다(v1.5.1)
    if (faceDownPref()) flip.ensure();
  }
  renderFlipChip();
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
    if (u.emailAddress) { drive.email = u.emailAddress; localStorage.setItem("hemory.email", u.emailAddress); }
    if (S.tab === "settings") renderSettings();
  }).catch(() => {});
  if (drive.needsReconnect && !drive.tokenValid) showConnBar();
  const cached = await store.allRecords().catch(() => []);
  if (cached.length) {
    S.records = cached.sort(byRecent);
    reindex();
    renderTimeline();
  } else {
    $("#dayview").innerHTML = '<div class="loading"><span class="spinner dark"></span></div>';
  }
  setTab("timeline");
  applyDeepLink();
  restoreFaceDown();                       // 저장된 뒤집어 녹음 설정을 되살린다(v1.5.1)
  checkLocalRecovery().catch(() => {});
  refreshQueue({ force: true }).then(() => queueTick(true));   // 기기에 남은 업로드를 먼저 보낸다
  syncNow();
}

/* 매니페스트 바로가기(?tab=search, ?action=record) */
function applyDeepLink() {
  const p = new URLSearchParams(location.search);
  if (p.get("tab") === "search") setTab("search");
  if (p.get("tab") === "people") setTab("people");
  if (p.get("tab") === "agent") setTab("agent");
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
async function syncNow({ manual = false, auto = false } = {}) {
  if (S.mode !== "live" || S.syncState === "syncing") return;
  S.syncState = "syncing";
  if (!auto) syncSpin(true);
  const beforeSig = recordSignature(S.records);
  const beforePending = new Set(S.records.filter((r) => r.status === "pending").map((r) => r.base));
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
    const changed = recordSignature(S.records) !== beforeSig;
    if (changed) {
      reindex();
      await store.replaceAll(S.records.filter((r) => !r.demo)).catch(() => {});
      renderTimeline();
      if (S.tab === "search") renderSearch();
    }
    hideConnBar();
    S.lastSync = Date.now();
    await store.setKV("lastSync", S.lastSync).catch(() => {});
    flushPending().catch(() => {});
    refreshQueue();
    S.syncState = "idle";
    syncSpin(false);
    // 자동 반영으로 "전사 대기"가 실제 기록이 되면 조용하지 않게 한 번만 알린다
    if (auto && changed) {
      const filled = S.records.filter((r) => r.fileId && r.status !== "pending" && beforePending.has(r.base));
      if (filled.length) toast(`전사 완료 · ${filled[0].title}`, 2600);
    }
    if (manual) toast(`동기화 완료 · 기록 ${S.records.length}건`);
  } catch (e) {
    S.syncState = "idle";
    syncSpin(false);
    if (e instanceof AuthError) {
      // 토큰이 만료된 것이지 로그아웃된 것이 아니다. 첫 화면으로 돌아가지 않는다.
      if (e.code === "needs_reconnect") showConnBar(e.code);
      else if (!auto) toast(e.message);
    } else if (!auto) {
      toast("동기화 실패: " + (e.message || "알 수 없는 오류"));
    } else {
      console.warn("auto sync failed", e);      // 자동 동기화는 조용히 다음 회차에 다시 시도한다
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
    segment: data.segment || null,
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

function filteredRecords() {
  const day = recordsOnDay(S.day);
  return S.filter === "all" ? day : day.filter((r) => r.type === S.filter);
}

function setSelectMode(on) {
  S.sel.on = !!on;
  S.sel.ids.clear();
  renderTimeline();
  if (S.sel.on) toast("블록을 눌러 선택하세요", 1800);
}

/* 동기화 중 표시 — 상단 메뉴 버튼 옆 회전 */
function syncSpin(on) {
  const b = $("#btn-menu");
  if (b) b.classList.toggle("spin", !!on);
}

function toggleSel(id) {
  if (S.sel.ids.has(id)) S.sel.ids.delete(id);
  else S.sel.ids.add(id);
  renderTimeline();
}

function renderSelBar() {
  const bar = $("#del-bar");
  if (!bar) return;
  if (!S.sel.on) { bar.hidden = true; bar.innerHTML = ""; return; }
  const n = S.sel.ids.size;
  bar.hidden = false;
  bar.innerHTML = `<span class="db-n">${n}개 선택</span>
    <button class="db-btn" id="db-all">전체 선택</button>
    <button class="db-btn danger" id="db-del" ${n ? "" : "disabled"}>삭제</button>`;
  $("#db-all", bar).addEventListener("click", () => {
    const all = filteredRecords();
    S.sel.ids = new Set(S.sel.ids.size === all.length ? [] : all.map((r) => r.id));
    renderTimeline();
  });
  $("#db-del", bar).addEventListener("click", () => {
    confirmDeleteRecords(S.records.filter((r) => S.sel.ids.has(r.id)));
  });
}

/* 삭제 — 드라이브는 휴지통으로(30일 복원 가능), 기기 캐시·인덱스는 즉시 제거 */
function confirmDeleteRecords(recs) {
  const list = (recs || []).filter(Boolean);
  if (!list.length) return;
  const n = list.length;
  const rows = list.slice(0, 6).map((r) => `<div class="del-row"><span class="dr-t">${esc(fmtDay(r.started_at))} ${esc(fmtTime(r.started_at))}</span><span class="dr-n">${esc(r.title || "")}</span></div>`).join("");
  const sheet = openSheet({
    title: n === 1 ? "이 녹음을 삭제할까요?" : `${n}개 녹음을 삭제할까요?`,
    sub: "드라이브 휴지통으로 이동합니다 · 30일 안에 복원할 수 있습니다",
    body: `<div class="del-list">${rows}${n > 6 ? `<div class="del-row muted"><span>외 ${n - 6}개</span></div>` : ""}</div>
      <p class="note" style="margin-top:12px">이 기기의 캐시와 검색 인덱스에서도 바로 사라집니다.</p>`,
    foot: `<div style="display:flex;gap:8px"><button class="btn btn-ghost btn-block" id="del-cancel">취소</button><button class="btn btn-danger btn-block" id="del-ok">삭제</button></div>`,
  });
  $("#del-cancel", sheet).addEventListener("click", () => closeSheet());
  $("#del-ok", sheet).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    await deleteRecords(list);
  });
}

async function deleteRecords(list) {
  const done = new Set();
  let failed = 0;
  for (const r of list) {
    const fileIds = [r.fileId, r.audioId].filter(Boolean);
    let ok = true;
    if (fileIds.length) {
      const res = await drive.trashMany(fileIds);
      failed += res.failed.length;
      ok = res.failed.length === 0;
    }
    if (!ok) continue;
    done.add(r.id);
    try { await store.deleteRecords([r.id]); } catch {}
    if (r.base) store.pendingDelBase(r.base).catch(() => {});
  }
  if (done.size) {
    S.records = S.records.filter((r) => !done.has(r.id));
    S.sel.ids = new Set([...S.sel.ids].filter((id) => !done.has(id)));
    reindex();
  }
  closeSheet();
  if (S.sel.on && !S.sel.ids.size) setSelectMode(false);
  else renderTimeline();
  if (failed) toast(`삭제하지 못한 파일 ${failed}개 · 연결을 확인해 주세요`, 3600);
  else toast(`${done.size}개 삭제했습니다`);
}

/* ────────────────────────────────── 타임라인 ── */
function recordsOnDay(key) {
  return S.records
    .filter((r) => dayKey(r.started_at) === key)
    .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
}

function dotsFor(key) {
  return Math.min(3, recordsOnDay(key).length);
}

function renderWeek() {
  const strip = $("#weekstrip");
  if (!strip) return;
  const today = dateKeyOf(new Date());
  S.week = weekDays(S.day, 7);
  strip.innerHTML = S.week.map((d) => {
    const on = d.key === S.day;
    const n = dotsFor(d.key);
    return `<button class="wd ${on ? "on" : ""} ${d.key === today ? "today" : ""}" data-day="${d.key}" role="tab" aria-selected="${on}">
      <span class="wd-dow">${DAY_LABELS[d.dow]}</span>
      <span class="wd-day">${d.day}</span>
      <span class="wd-dots">${Array.from({ length: n }, () => "<i></i>").join("")}</span>
    </button>`;
  }).join("");
  $$("#weekstrip .wd").forEach((b) => b.addEventListener("click", () => {
    if (S.sel.on) setSelectMode(false);
    S.day = b.dataset.day;
    renderTimeline();
  }));
}

function renderDayHeader() {
  const [y, m] = String(S.day).split("-");
  const el = $("#dn-month-text");
  if (el) el.textContent = `${y} / ${String(Number(m)).padStart(2, "0")}`;
  const t = $("#btn-today");
  if (t) t.classList.toggle("on", S.day === dateKeyOf(new Date()));
}

/* 블록 하단 정보 — 화자/전사 상태 */
function blockFoot(rec) {
  if (rec.status === "pending") return "전사 대기 · 맥이 처리하면 요약이 채워집니다";
  const sp = rec.speakers || [];
  const segs = rec.segments || [];
  if (sp.length) return `화자 ${sp.length}명 · ${sp.slice(0, 3).join(" · ")}${sp.length > 3 ? ` 외 ${sp.length - 3}명` : ""}`;
  if (segs.length) return `화자 미확인 · 문장 ${segs.length}개`;
  return `기록 ${fmtDuration(rec.duration_sec || 0)}`;
}

function renderDay() {
  const view = $("#dayview");
  if (!view) return;
  const recs = recordsOnDay(S.day);
  const status = $("#tl-status");
  if (status) {
    if (S.mode === "demo") {
      status.hidden = false;
      status.innerHTML = `데모 기록 <b>${recs.length}건</b> · 실제 저장은 되지 않습니다`;
    } else { status.hidden = true; status.innerHTML = ""; }
  }

  if (!recs.length) {
    // 빈 날: 06:00~22:00 눈금만
    const top = 10, step = 46, from = 6, to = 22;
    let html = `<div class="grid" style="height:${(to - from) * step + 46}px"><div class="hlabels">`;
    for (let h = from; h <= to; h++) html += `<span class="hlabel" style="top:${(h - from) * step + top}px">${String(h).padStart(2, "0")}:00</span>`;
    html += `</div><div class="canvas"><span class="spine" style="top:${top}px;height:${(to - from) * step}px;opacity:.18"></span>`;
    for (let h = from; h <= to; h++) html += `<span class="hline" style="top:${(h - from) * step + top}px"></span>`;
    html += `<div class="day-empty"><b>이 날은 기록이 없습니다</b>아래 버튼으로 녹음을 시작하거나<br>아이폰 음성 메모를 올리면 여기에 쌓입니다.</div>`;
    html += `</div></div>`;
    view.innerHTML = html;
    return;
  }

  const flow = timelineFlow(recs.map((r) => ({
    id: r.id,
    startMin: minutesOf(r.started_at),
    durationSec: r.duration_sec || 0,
  })));
  const byId = new Map(recs.map((r) => [r.id, r]));

  /* 시간 눈금: 흐름의 정시 눈금 + 블록의 실제 시작/종료(정시 눈금과 겹치면 생략) */
  const near = (m) => flow.ticks.some((t) => Math.abs(t.min - m) <= 14);
  const edges = [];
  for (const b of flow.blocks) {
    edges.push([Math.round(b.startMin), b.top]);
    edges.push([Math.round(b.endMin), b.top + b.height]);
  }
  const edgeLabels = [];
  for (const [m, top] of edges.slice().sort((a, b) => a[1] - b[1])) {
    if (near(m)) continue;
    if (edgeLabels.some((e) => Math.abs(e.top - top) < 12)) continue;   // 붙어 있는 시작/종료 라벨은 하나만
    edgeLabels.push({ m, top });
  }
  let labels = flow.ticks.map((t) => `<span class="hlabel" style="top:${t.top}px">${hhmm(t.min)}</span>`).join("")
    + edgeLabels.map((e) => `<span class="hlabel edge" style="top:${e.top}px">${hhmm(e.m)}</span>`).join("");

  let lines = flow.ticks.map((t) => `<span class="hline" style="top:${t.top}px"></span>`).join("");
  const first = flow.blocks[0];
  const last = flow.blocks[flow.blocks.length - 1];
  lines += `<span class="spine" style="top:${first.top}px;height:${last.top + last.height - first.top}px"></span>`;

  const blocks = flow.blocks.map((b) => {
    const r = byId.get(b.id);
    const short = b.height < 128;
    const picked = S.sel.ids.has(r.id);
    return `<button class="blk ${r.status === "pending" ? "pending" : ""} ${picked ? "on" : ""}" data-id="${esc(r.id)}" data-short="${short ? 1 : 0}" style="top:${b.top}px;height:${b.height}px">
      <span class="blk-range">${esc(blockRangeLabel(r.started_at, r.duration_sec))}</span>
      <span class="blk-wm">${CATEGORY_WORD[r.type] || "ETC"}</span>
      <span class="blk-title">${esc(r.title || "제목 없는 기록")}</span>
      <span class="blk-foot">${esc(blockFoot(r))}</span>
      ${S.sel.on ? `<span class="ck" aria-hidden="true">${picked ? "✓" : ""}</span>` : ""}
    </button>`;
  }).join("");

  view.innerHTML = `<div class="grid" style="height:${flow.height}px">
    <div class="hlabels">${labels}</div>
    <div class="canvas">${lines}${blocks}</div>
  </div>`;

  $$("#dayview .blk").forEach((el) => el.addEventListener("click", () => {
    const rec = S.records.find((r) => r.id === el.dataset.id);
    if (!rec) return;
    if (S.sel.on) { toggleSel(rec.id); return; }
    openDetail(rec);
  }));
  renderSelBar();
}

function renderTimeline() {
  renderDayHeader();
  renderWeek();
  renderDay();
  paintLastStart();
  maybeShowInstallTip();
}

/* 활동 탭의 목록 한 줄 */
function feedRowHTML(r) {
  const t = TYPES[r.type] || TYPES.etc;
  const line = previewLine(r);
  const pending = r.status === "pending";
  return `<button class="frow" data-id="${esc(r.id)}">
    <span class="frow-time">${esc(fmtTime(r.started_at))}</span>
    <span class="frow-main">
      <span class="frow-top"><span class="tag ${r.type === "meeting" ? "meeting" : ""}">${esc(t.label)}</span>${pending ? '<span class="tag pending">전사 대기</span>' : ""}<span class="frow-date">${esc(fmtDay(r.started_at))}</span></span>
      <b class="frow-title">${esc(r.title || "제목 없는 기록")}</b>
      ${line ? `<span class="frow-line">${esc(line)}</span>` : ""}
    </span>
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
    const list = S.filter === "all" ? S.records : S.records.filter((r) => r.type === S.filter);
    if (!list.length) {
      body.innerHTML = `<div class="empty"><h3>아직 기록이 없습니다</h3><p>타임라인에서 녹음을 시작하거나,<br>아이폰 음성 메모를 <b>${esc(CONFIG.rootFolder)}</b> 폴더에 올려 보세요.</p></div>`;
      return;
    }
    const kw = keywords(S.index, 8);
    body.innerHTML = `<div class="search-hint">최근 기록 ${list.length}건 · 요약</div>
      <div class="feed">${list.slice(0, 40).map(feedRowHTML).join("")}</div>
      ${kw.length ? `<div class="chips" style="flex-wrap:wrap;padding:16px 12px 0">${kw.map((k) => `<button class="chip" data-kw="${esc(k)}">${esc(k)}</button>`).join("")}</div>` : ""}`;
    $$("#search-body [data-kw]").forEach((b) => b.addEventListener("click", () => {
      S.query = b.dataset.kw; $("#q").value = S.query; renderSearch();
    }));
    $$("#search-body .frow").forEach((b) => b.addEventListener("click", () => {
      const rec = S.records.find((r) => r.id === b.dataset.id);
      if (rec) openDetail(rec);
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
  await askInto($("#search-body"), q);
}

/* 질문 → 근거 → (Gemini 키가 있으면) 답변. 활동 탭과 에이전트 탭이 같은 함수를 쓴다. */
async function askInto(body, q) {
  if (!body) return;
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
    bindAskSources(body);
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
  bindAskSources(body);
}

function bindAskSources(root = document) {
  $$(".src", root).forEach((b) => b.addEventListener("click", () => {
    const rec = S.records.find((r) => r.id === b.dataset.rid);
    if (rec) openDetail(rec, { seek: b.dataset.t ? Number(b.dataset.t) : null });
  }));
}

/* ────────────────────────────────── 인물 ── */
function speakerIndex() {
  const map = new Map();
  const touch = (name) => {
    let p = map.get(name);
    if (!p) { p = { name, records: new Set(), segs: 0, last: 0, lines: [] }; map.set(name, p); }
    return p;
  };
  for (const r of S.records) {
    const sp = r.speakers || [];
    const ts = new Date(r.started_at).getTime() || 0;
    const seen = new Set();
    for (const s of r.segments || []) {
      const name = s.speaker || (sp.length === 1 ? sp[0] : "");
      if (!name) continue;
      const p = touch(name);
      p.records.add(r.id);
      p.segs += 1;
      p.last = Math.max(p.last, ts);
      p.lines.push({ rec: r, t: s.start, text: s.text });
      seen.add(name);
    }
    for (const name of sp) {
      if (seen.has(name)) continue;
      const p = touch(name);
      p.records.add(r.id);
      p.last = Math.max(p.last, ts);
    }
  }
  return [...map.values()].sort((a, b) => b.last - a.last || b.segs - a.segs);
}

function initialOf(name = "") {
  const s = String(name).trim();
  if (!s) return "?";
  if (/^[A-Za-z]/.test(s)) return s.slice(0, 2).toUpperCase();
  return s.slice(0, 1);
}

function renderPeople() {
  const list = $("#people-list");
  const sum = $("#people-sum");
  if (!list) return;
  const people = speakerIndex();
  const unknown = S.records.filter((r) => !(r.speakers || []).length && (r.segments || []).length).length;
  if (sum) sum.innerHTML = `<span><b>${people.length}</b>명의 화자</span><span><b>${S.records.length}</b>개 기록</span>${unknown ? `<span><b>${unknown}</b>건 화자 미확인</span>` : ""}`;
  if (!people.length) {
    list.innerHTML = `<div class="empty"><h3>아직 확인된 화자가 없습니다</h3><p>전사가 끝난 기록에서 화자 이름이 잡히면<br>여기에 사람별로 모입니다.</p></div>`;
    return;
  }
  list.innerHTML = people.map((p) => `<button class="person" data-name="${esc(p.name)}">
    <span class="avatar">${esc(initialOf(p.name))}</span>
    <span class="p-main"><b>${esc(p.name)}</b><span>기록 ${p.records.size} · 문장 ${p.segs}${p.last ? ` · 최근 ${esc(fmtDay(new Date(p.last).toISOString()))}` : ""}</span></span>
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`).join("");
  $$("#people-list .person").forEach((b) => b.addEventListener("click", () => openPerson(b.dataset.name)));
}

function openPerson(name) {
  const people = speakerIndex();
  const p = people.find((x) => x.name === name);
  if (!p) return;
  const byRec = new Map();
  for (const l of p.lines) {
    if (!byRec.has(l.rec.id)) byRec.set(l.rec.id, { rec: l.rec, lines: [] });
    byRec.get(l.rec.id).lines.push(l);
  }
  for (const rid of p.records) {
    if (byRec.has(rid)) continue;
    const rec = S.records.find((r) => r.id === rid);
    if (rec) byRec.set(rid, { rec, lines: [] });
  }
  const rows = [...byRec.values()]
    .sort((a, b) => new Date(b.rec.started_at) - new Date(a.rec.started_at))
    .map(({ rec, lines }) => `<section class="detail-sec">
      <h3>${esc(fmtDay(rec.started_at))} · ${esc(fmtTime(rec.started_at))} · ${esc(fmtDuration(rec.duration_sec || 0))}</h3>
      <button class="p-line" data-rid="${esc(rec.id)}" style="width:100%;text-align:left;border:0;background:none;padding:6px 0">
        <span style="font-size:13.5px;color:var(--ink);font-weight:600">${esc(rec.title || "제목 없는 기록")}</span>
        ${lines.slice(0, 3).map((l) => `<span style="display:block;font-size:10.5px;color:var(--muted-2);margin-top:4px">${fmtClock(l.t || 0)}</span><span style="display:block;font-size:13px;line-height:1.55;color:var(--ink-2)">${esc(l.text)}</span>`).join("")}
        ${lines.length > 3 ? `<span style="display:block;font-size:11px;color:var(--muted-2);margin-top:6px">외 ${lines.length - 3}문장</span>` : ""}
      </button>
    </section>`).join("");
  const sheet = openSheet({
    title: name,
    sub: `<span>기록 ${p.records.size} · 문장 ${p.segs}</span>`,
    body: rows || `<div class="empty"><h3>문장이 아직 없습니다</h3><p>이 기록은 전사 대기 중입니다.</p></div>`,
    tall: true,
  });
  $$(".p-line", sheet).forEach((b) => b.addEventListener("click", () => {
    const rec = S.records.find((r) => r.id === b.dataset.rid);
    if (rec) openDetail(rec);
  }));
}

/* ────────────────────────────────── 에이전트 ── */
function renderAgent() {
  const badge = $("#agent-badge");
  if (badge) badge.textContent = hasGemini() ? "Gemini 연결됨" : "Gemini 키 없음";
  const hint = $("#agent-hint");
  if (hint) hint.textContent = hasGemini()
    ? "근거가 된 문장과 함께 답합니다."
    : "지금은 근거 문장만 모아 보여 줍니다 · 설정에서 Gemini 키를 넣으면 답변까지 만듭니다.";
}

/* ────────────────────────────────── 메뉴 · 날짜 고르기 ── */
function openMenuSheet() {
  const email = S.mode === "live" ? (localStorage.getItem("hemory.email") || "") : "";
  const dayN = recordsOnDay(S.day).length;
  const sheet = openSheet({
    title: "메뉴",
    sub: `<span>${esc(fmtDay(S.day + "T00:00:00"))}</span><span>기록 ${dayN}건</span>${S.mode === "demo" ? "<span>데모</span>" : ""}`,
    body: `<div style="padding:4px 16px 8px">
      ${email ? `<div class="srow"><span class="k">계정</span><span class="v">${esc(email)}</span></div>` : ""}
      <button class="btn btn-line btn-block" id="menu-settings">설정 열기</button>
      <button class="btn btn-line btn-block" id="menu-select">${S.sel.on ? "선택 끝내기" : "선택해서 삭제"}</button>
      <button class="btn btn-line btn-block" id="menu-sync">지금 동기화</button>
      <button class="btn btn-line btn-block" id="menu-today">오늘로 이동</button>
      <button class="btn btn-ghost btn-block" id="menu-date">다른 날짜 고르기</button>
      <p class="note">뒤집어 녹음 상태는 타임라인 아래 칩에서 바로 확인할 수 있습니다.</p>
    </div>`,
  });
  $("#menu-settings", sheet).addEventListener("click", () => { closeSheet(); setTab("settings"); });
  $("#menu-select", sheet).addEventListener("click", () => { closeSheet(); setSelectMode(!S.sel.on); });
  $("#menu-sync", sheet).addEventListener("click", () => { closeSheet(); syncNow({ manual: true }); });
  $("#menu-today", sheet).addEventListener("click", () => { closeSheet(); gotoToday(); });
  $("#menu-date", sheet).addEventListener("click", () => { closeSheet(); openDayPicker(); });
}

function gotoToday() {
  S.day = dateKeyOf(new Date());
  renderTimeline();
}

function openDayPicker() {
  let [yy, mm] = String(S.day).split("-").map(Number);
  const sheet = openSheet({ title: "날짜 고르기", body: `<div id="cal-wrap" style="padding:6px 12px 0"></div>` });
  const wrap = $("#cal-wrap", sheet);
  const draw = () => {
    const first = new Date(yy, mm - 1, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const today = dateKeyOf(new Date());
    let cells = "";
    for (let i = 0; i < startDow; i++) cells += `<span></span>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const n = recordsOnDay(key).length;
      cells += `<button class="cal-day ${key === S.day ? "on" : ""} ${key === today ? "today" : ""}" data-day="${key}">${d}${n ? `<i></i>` : ""}</button>`;
    }
    wrap.innerHTML = `<div class="cal-head">
        <button id="cal-prev" aria-label="이전 달">‹</button>
        <b>${yy}년 ${mm}월</b>
        <button id="cal-next" aria-label="다음 달">›</button>
      </div>
      <div class="cal-grid">${["일", "월", "화", "수", "목", "금", "토"].map((d) => `<span class="cal-dow">${d}</span>`).join("")}${cells}</div>
      <p class="note" style="padding:0 6px 6px">점이 있는 날에 기록이 있습니다.</p>`;
    $("#cal-prev", wrap).addEventListener("click", () => { mm--; if (mm < 1) { mm = 12; yy--; } draw(); });
    $("#cal-next", wrap).addEventListener("click", () => { mm++; if (mm > 12) { mm = 1; yy++; } draw(); });
    $$(".cal-day", wrap).forEach((b) => b.addEventListener("click", () => {
      S.day = b.dataset.day;
      closeSheet();
      renderTimeline();
    }));
  };
  draw();
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
    const lastStart = Number(rec.segments[rec.segments.length - 1]?.start) || 0;
    const long = (rec.duration_sec || 0) > SEGMENT_SEC || lastStart > SEGMENT_SEC;
    const blocks = long ? groupTranscript(rec.segments) : [{ label: "", segments: rec.segments }];
    const trHTML = blocks.map((b) => `${b.label ? `<div class="tr-head">${esc(b.label)}</div>` : ""}${
      b.segments.map((s) => `<button class="tr" data-t="${s.start}" data-i="${s.i}">
        <span class="tr-t">${fmtClock(s.start)}</span>
        <span class="tr-body">${s.speaker ? `<span class="tr-sp">${esc(s.speaker)}</span>` : ""}${esc(s.text)}</span>
      </button>`).join("")}`).join("");
    bodyHTML += `<section class="detail-sec" style="padding-bottom:4px"><h3>전사 ${rec.segments.length}문장${long ? " · 30분 단위" : ""}</h3><div class="tr-hint">문장을 누르면 그 지점부터 재생됩니다.</div></section>
      <div class="transcript" id="transcript">${trHTML}</div>`;
  }

  if (rec.webViewLink) {
    bodyHTML += `<section class="detail-sec"><a href="${esc(rec.webViewLink)}" target="_blank" rel="noopener" style="font-size:12.5px;color:var(--muted);text-decoration:underline;text-underline-offset:3px">드라이브에서 원본 열기</a></section>`;
  }

  if (S.mode === "live" && !rec.demo) {
    bodyHTML += `<section class="detail-sec"><button class="link-danger" id="btn-del-one">이 녹음 삭제</button></section>`;
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
      <div class="pl-status" id="pl-status" hidden></div>
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

  $("#btn-del-one", sheet)?.addEventListener("click", () => confirmDeleteRecords([rec]));

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
    title: $("#pl-title"), rate: $("#pl-rate"), status: $("#pl-status"),
  };
  if (!nodes.toggle) return;

  const canLoad = !!(rec.audioId && S.mode === "live");
  let objectUrl = null;
  let loading = null;
  let ready = false;
  let durFixed = false;

  const setStatus = (text, kind = "") => {
    const el = nodes.status;
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ""; el.className = "pl-status"; return; }
    el.hidden = false;
    el.textContent = text;
    el.className = "pl-status" + (kind ? " " + kind : "");
  };

  /* 아이폰은 <audio src> 에 Authorization 헤더를 못 붙인다 → 토큰으로 받아 Blob URL 로 재생 */
  const load = () => {
    if (!canLoad) return Promise.reject(new Error("오디오 파일이 없습니다"));
    if (ready) return Promise.resolve(objectUrl);
    if (loading) return loading;
    setStatus("오디오를 불러오는 중…", "loading");
    nodes.toggle.classList.add("busy");
    loading = (async () => {
      let blob = audioCache.get(rec.audioId);
      if (!blob) {
        blob = await drive.audioBlob(rec.audioId, { name: rec.audioName || "" });
        rememberAudio(rec.audioId, blob);
      }
      objectUrl = URL.createObjectURL(blob);
      audio.src = objectUrl;
      try { audio.load(); } catch {}
      ready = true;
      nodes.toggle.classList.remove("busy");
      setStatus("");
      return objectUrl;
    })();
    loading = loading.catch((e) => {
      nodes.toggle.classList.remove("busy");
      setStatus((e?.message || "오디오를 불러오지 못했습니다") + " · 다시 누르면 재시도합니다", "error");
      ready = false;
      loading = null;
      throw e;
    });
    return loading;
  };

  const playNow = () => audio.play().then(() => setPlaying(true)).catch((e) => {
    setStatus("재생할 수 없습니다 · " + (e?.name === "NotSupportedError" ? "이 기기에서 재생할 수 없는 형식입니다" : (e?.message || "오류")), "error");
    setPlaying(false);
  });

  const ensureThen = (fn) => { load().then(() => fn()).catch(() => {}); };

  const icon = (playing) => (playing
    ? '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" style="margin-left:2px"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>');

  nodes.toggle.parentElement.appendChild(audio);
  const setPlaying = (p) => { nodes.toggle.innerHTML = icon(p); };
  setPlaying(false);

  const seek = (t) => {
    const at = Math.max(0, Number(t) || 0);
    if (!audio.src) {
      if (!canLoad) { highlightSegment(at); return; }
      ensureThen(() => { try { audio.currentTime = at; } catch {} playNow(); highlightSegment(at); });
      return;
    }
    try { audio.currentTime = at; } catch {}
    if (audio.paused) playNow();
  };

  nodes.toggle.addEventListener("click", () => {
    if (!audio.src) {
      if (rec.demo) return toast("데모에는 오디오가 없습니다");
      if (!canLoad) return toast("오디오 파일이 없습니다");
      ensureThen(playNow);
      return;
    }
    if (audio.paused) playNow();
    else { audio.pause(); setPlaying(false); }
  });

  $("#pl-back")?.addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  $("#pl-fwd")?.addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 15); });
  nodes.rate?.addEventListener("click", () => {
    rate = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 0.8 : 1;
    audio.playbackRate = rate;
    nodes.rate.textContent = rate + "×";
  });

  const paintDuration = (d) => {
    if (nodes.dur) nodes.dur.textContent = fmtClock(d || rec.duration_sec || 0);
  };
  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration) && audio.duration > 0) { paintDuration(audio.duration); return; }
    // m4a 를 Blob 으로 재생할 때 duration 이 Infinity 로 나오는 iOS 버그 회피
    if (!durFixed) { durFixed = true; try { audio.currentTime = 1e7; } catch {} }
  });
  audio.addEventListener("durationchange", () => {
    if (isFinite(audio.duration) && audio.duration > 0) {
      paintDuration(audio.duration);
      if (durFixed) { try { audio.currentTime = 0; } catch {} }
    }
  });
  audio.addEventListener("timeupdate", () => {
    const d = audio.duration && isFinite(audio.duration) ? audio.duration : (rec.duration_sec || 1);
    nodes.fill.style.width = Math.min(100, (audio.currentTime / d) * 100) + "%";
    nodes.cur.textContent = fmtClock(audio.currentTime);
    highlightSegment(audio.currentTime);
  });
  audio.addEventListener("ended", () => setPlaying(false));
  audio.addEventListener("pause", () => setPlaying(false));
  audio.addEventListener("play", () => setPlaying(true));
  audio.addEventListener("error", () => {
    if (!audio.src) return;
    ready = false;
    setStatus("오디오 재생 오류 · 다시 누르면 재시도합니다", "error");
  });

  let segNodes = [];
  function collectSegNodes() { segNodes = $$("#transcript .tr"); }
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

  S.player = {
    audio, rec,
    stop: () => {
      try { audio.pause(); audio.src = ""; } catch {}
      if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch {} objectUrl = null; }
    },
  };
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
  if (sheet) { try { sheet._onClose?.(); } catch (e) { console.warn(e); } }
  // 닫힌 시트를 계속 '열려 있는 시트'로 참조하면 엎어 녹음·예약 녹음이 영영 막힌다
  S.sheet = null;
  if (!sheet) { if (immediate) root.innerHTML = ""; return; }
  if (immediate) { root.innerHTML = ""; return; }
  sheet.style.transform = "";
  sheet.classList.remove("show");
  backdrop?.classList.remove("show");
  _sheetClearTimer = setTimeout(() => { root.innerHTML = ""; }, 260);
}

/* ────────────────────────────────── 설정 ── */
function connState() {
  if (!drive.hasSession) return "—";
  if (drive.tokenValid) return "자동 유지 중";
  if (drive.needsReconnect) return "다시 연결 필요";
  return "자동 갱신 중";
}

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
  <div class="sgroup" id="sgroup-account">
    <h2>계정</h2>
    <div class="srow"><span class="k">${S.mode === "live" ? "Google 드라이브 연결됨" : "연결 안 됨"}</span>
      <span class="v">${esc(email || (drive.signedIn ? "연결됨" : "—"))}</span></div>
    <div class="srow"><span class="k">로그인 유지</span><span class="v">${connState()}</span></div>
    <div class="srow"><span class="k">마지막 동기화</span><span class="v">${lastSync ? lastSync.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "—"}</span></div>
    <div class="srow"><span class="k">저장 위치</span><span class="v">내 드라이브 / ${esc(CONFIG.rootFolder)}</span></div>
    <div class="srow"><span class="k">보관 기간</span><span class="v">${CONFIG.retentionDays}일 지나면 자동 정리</span></div>
    <button class="btn btn-line btn-block" id="s-sync">지금 동기화</button>
    ${S.mode === "live" && !drive.tokenValid ? '<button class="btn btn-line btn-block" id="s-reconnect">다시 연결</button>' : ""}
    ${S.mode === "live" ? '<button class="btn btn-ghost btn-block" id="s-out">연결 해제</button>' : '<button class="btn btn-ghost btn-block" id="s-login">Google 연결</button>'}
  </div>

  <div class="sgroup" id="sgroup-ai">
    <h2>AI</h2>
    <div class="srow"><span class="k">Gemini API 키</span><span class="v">${hasGemini() ? "설정됨" : "없음"}</span></div>
    <p class="note">키가 있으면 ① 기록에 질문해 답을 만들고 ② 짧은 녹음을 폰에서 바로 전사합니다. 키는 이 기기에만 저장되고 드라이브에 올라가지 않습니다.</p>
    <div class="field"><label>API 키 (AI Studio에서 발급)</label>
      <input id="s-key" type="password" inputmode="text" autocomplete="off" spellcheck="false" placeholder="AQ... 또는 AIza..." value="${esc(s.geminiKey || "")}">
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

  <div class="sgroup" id="sgroup-schedule">
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

  <div class="sgroup" id="sgroup-flip">
    <h2>뒤집어서 자동 녹음</h2>
    <div class="srow"><span class="k">뒤집어 녹음</span>
      <button class="sw" id="s-flip-on" role="switch" aria-checked="${faceDownPref() ? "true" : "false"}" aria-label="뒤집어서 자동 녹음"${flip.supported ? "" : " disabled"}><i></i></button></div>
    <div class="srow"><span class="k">센서 권한</span><span class="v" id="s-flip-perm">${flip.perm === "denied" ? "차단됨" : flip.granted ? (flip.hasSignal ? "허용됨 · 신호 정상" : "허용됨") : "확인 필요"}</span></div>
    <div class="srow"><span class="k">마이크 연결</span><span class="v" id="s-flip-mic" data-mic="lost">${micStatus().live ? "연결됨 · 대기 중에도 열어 둠" : "아직 열지 않음"}</span></div>
    <div class="flip-test">
      <div class="flip-now" id="s-flip-now">—</div>
      <div class="flip-verdict" id="s-flip-verdict" data-pose="${flip.pose}">${flip.active ? "녹음 중입니다" : "폰을 엎으면 이 칸이 검게 바뀝니다"}</div>
    </div>
    <button class="btn btn-line btn-block" id="s-flip-perm">센서 권한 허용 · 다시 요청</button>
    <button class="btn btn-ghost btn-block" id="s-flip-mic-btn">마이크 다시 연결</button>
    <a class="btn btn-ghost btn-block" href="demo/flip-lab.html" target="_blank" rel="noopener">센서 테스트 열기 (녹음 없이 확인)</a>
    <p class="note">켜 두면 <b>어느 화면에 있든</b> 폰을 엎기만 하면 1.5초 뒤 녹음이 시작되고 화면은 검게 절전합니다. 다시 들면 자동 저장.<br>
    아이폰은 앱을 새로 열 때마다 센서 권한을 한 번 더 물어봅니다(브라우저 보안 규칙). 위 상태가 <b>허용됨 · 신호 정상</b>이면 준비된 것이고, <b>확인 필요</b>면 <b>센서 권한 허용</b>을 한 번 눌러 주세요.<br>
    <b>마이크는 한 번 열면 계속 들고 있습니다</b> — 그래서 두 번째·세 번째 엎기에도 다시 세팅할 필요가 없습니다. 앱을 잠깐 <b>나갔다 돌아와도</b> 마이크·센서를 다시 묻지 않고 이어 씁니다(트랙이 살아 있으면 그대로, iOS가 끊었으면 조용히 다시 연결). 대기 중에는 아이폰 상단에 <b>주황색 마이크 표시</b>가 남습니다(소리를 담고 있지는 않습니다). 전화·화면 잠금으로 끊겨 상태가 바뀌면 이 화면의 <b>마이크 다시 연결</b>을 누르거나 화면을 한 번 탭하면 됩니다.</p>
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
    <div class="srow"><span class="k">버전</span><span class="v" id="s-version">${CONFIG.version}</span></div>
    <div class="srow"><span class="k">캐시 키</span><span class="v">hemory-v${esc(CONFIG.version)}</span></div>
    <div class="srow"><span class="k">전사 파이프라인</span><span class="v">맥 자동 처리</span></div>
    <button class="btn btn-line btn-block" id="s-update">업데이트 확인</button>
    <p class="note">새 버전이 나오면 이 버튼을 누르거나, 앱을 다시 열었을 때 자동으로 확인해 <b>캐시를 지우고 새로 엽니다</b>. 그래도 예전 화면이 보이면 아래 캐시 비우기를 한 번 눌러 주세요.</p>
  </div>`;

  $("#s-sync").addEventListener("click", () => syncNow({ manual: true }));
  $("#s-reconnect")?.addEventListener("click", reconnect);
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
  $("#s-update")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "확인 중…";
    const r = await checkForUpdate({ force: true });
    btn.disabled = false; btn.textContent = "업데이트 확인";
    if (!r.updated && !r.error) toast(`최신 버전입니다 (v${CONFIG.version})`);
  });
  $("#s-demo-exit")?.addEventListener("click", () => { S.mode = null; S.records = []; location.reload(); });
  $("#s-guide")?.addEventListener("click", openShortcutGuide);

  /* 예약 녹음 */
  $("#s-sch-on").addEventListener("click", () => {
    const next = saveSchedule({ enabled: !getSchedule().enabled });
    clearAutoMute();                     // 설정을 바꾸면 '이 슬롯은 꺼 둠'도 풀린다
    renderSettings();
    toast(next.enabled ? "예약 녹음 모드를 켰습니다" : "예약 녹음 모드를 껐습니다");
    schedTick();
  });
  $$("#settings-body .sch-day").forEach((btn) => btn.addEventListener("click", () => {
    const k = btn.dataset.day;
    const cur = getSchedule();
    const days = { ...cur.days, [k]: { ...cur.days[k], on: !cur.days[k].on } };
    saveSchedule({ days });
    clearAutoMute();
    renderSettings();
    schedTick();
  }));
  $$("#settings-body .sch-row input[type=time]").forEach((inp) => inp.addEventListener("change", () => {
    const k = inp.dataset.day, field = inp.dataset.k, val = inp.value;
    const cur = getSchedule();
    if (!/^\d{2}:\d{2}$/.test(val)) {
      inp.value = cur.days[k][field]; // 형식이 아닌 값은 되돌린다
      return;
    }
    const days = { ...cur.days, [k]: { ...cur.days[k], [field]: val } };
    saveSchedule({ days });
    clearAutoMute();
    toast("예약 시간을 저장했습니다");
    schedTick();
  }));
  $$("#settings-body [data-stype]").forEach((b) => b.addEventListener("click", () => {
    saveSchedule({ type: b.dataset.stype });
    renderSettings();
  }));

  /* 뒤집어 녹음 — 켤 때 탭 안에서 센서 권한 + 마이크 예열까지 */
  $("#s-flip-on")?.addEventListener("click", async () => {
    if (faceDownPref()) {
      setFaceDown(false);
      renderSettings();
      toast("뒤집어서 자동 녹음을 껐습니다");
      return;
    }
    const r = await flip.enable();
    const usable = r.ok || r.reason === "timeout" || r.reason === "unknown";
    if (usable) { prewarmMic(); unlockAudio(); ensureMicStandby(); }
    setFaceDown(usable);
    renderSettings();
    toast(
      r.ok ? "뒤집어 녹음을 켰습니다 · 앱을 켜 둔 채 폰을 엎어 보세요"
        : usable ? "켰습니다 · 권한 확인이 늦어지고 있어요(상태를 확인해 주세요)"
        : r.reason === "unsupported" ? "이 브라우저는 센서를 지원하지 않습니다"
        : "센서 권한이 거부되었습니다 · 아이폰 설정 → 앱 → 동작 및 방향 접근", 3600);
  });
  $("#s-flip-perm")?.addEventListener("click", async () => {
    const r = await flip.requestPermission();
    if (r.ok || r.reason === "timeout" || r.reason === "unknown") { prewarmMic(); unlockAudio(); ensureMicStandby({ gesture: true }); }
    flip.setArmed(faceDownPref() || r.ok);
    if (r.ok && !faceDownPref()) setFaceDown(true);
    renderSettings();
    toast(
      r.ok ? "센서 권한을 허용했습니다"
        : r.reason === "timeout" || r.reason === "unknown" ? "권한 창이 응답하지 않았습니다 · 한 번 더 눌러 주세요"
        : "권한이 거부되었습니다 · 아이폰 설정 → 앱 → 동작 및 방향 접근", 3600);
  });
  $("#s-flip-mic-btn")?.addEventListener("click", async () => {
    const ok = await ensureMicStandby({ gesture: true });
    renderSettings();
    toast(ok ? "마이크를 연결했습니다 · 폰을 엎으면 바로 녹음됩니다"
      : S.mic.denied ? "마이크 권한이 막혀 있습니다 · 아이폰 설정 → 앱 → 마이크"
      : "마이크를 열지 못했습니다 · 잠시 뒤 다시 눌러 주세요", 3200);
  });

  flip.setProbe(true);          // 설정 화면에서는 녹음 없이 센서 값만 보여 준다
  paintFlipReadout(true);
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
function openRecorder({ autoStart = false } = {}) {
  const R = S.recorder;
  if (S.auto.on || S.res.on || S.face.active) {
    return toast("예약·뒤집어·이어서 녹음이 진행 중입니다. 먼저 종료해 주세요");
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
          <span>${vadOK ? "말하지 않는 동안의 침묵은 전사에서 걸러냅니다 · 소리는 그대로 담깁니다" : "이 브라우저에서는 사용할 수 없습니다"}</span></div>
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
  S.recSheet = sheet;

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
    else if (recording() && (R.wake === "denied" || R.wake === "released")) bits.push(`<span class="rec-badge">화면 꺼짐 방지 안 됨 · 화면이 꺼지면 끊깁니다</span>`);
    else if (recording()) bits.push(`<span class="rec-badge">화면 꺼짐 방지 대기</span>`);
    else if (!wakeOK) bits.push(`<span class="rec-badge">화면 꺼짐 방지 미지원</span>`);
    if (R.vad || (vad && vadOK && !recording() && R.state === "idle")) {
      const t = recording() || R.state === "done" ? ` · 말한 구간 ${fmtClock(R.speechSec || 0)}` : "";
      bits.push(`<span class="rec-badge${recording() && R.speaking ? " on" : ""}">VAD${t}</span>`);
    } else if (recording() && R.wantVad) {
      // v1.6.1: iOS 가 AudioContext 를 잠가 아직 못 재고 있음 — 0초로 단정하지 않는다
      bits.push(`<span class="rec-badge">말한 구간 확인 중</span>`);
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
      setFaceDown(false);
      faceBtn.setAttribute("aria-checked", "false");
      toast("뒤집어서 자동 녹음을 껐습니다");
      return;
    }
    faceBtn.disabled = true;
    const r = await flip.enable();            // 탭 안에서 곧바로 센서 권한 요청
    const usable = r.ok || r.reason === "timeout" || r.reason === "unknown";
    if (usable) { prewarmMic(); unlockAudio(); } // 마이크·오디오도 미리 열어 둔다(제스처가 있을 때)
    faceBtn.disabled = false;
    if (!usable) {
      return toast(r.reason === "unsupported" ? "이 브라우저는 센서를 지원하지 않습니다" : "아이폰 설정 → 앱 → 동작 및 방향 접근을 허용해야 쓸 수 있습니다");
    }
    faceOn = true;
    setFaceDown(true);
    faceBtn.setAttribute("aria-checked", "true");
    toast("폰을 엎어 두면 1.5초 뒤 녹음이 시작되고, 들면 자동 저장됩니다");
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
        await R.start({ vad, keepMic: faceDownPref() });
      } catch (e) {
        return toast("마이크를 사용할 수 없습니다: " + (e.message || "권한 확인"));
      }
      haptic(12);
      // 30분마다 끊어 저장 + 기기 선저장 (수동 녹음도 동일하게)
      noteRecordingStart();
      beginLocalSession({ title: `새 녹음 ${fmtTime(new Date().toISOString())}`, type: localSettings().lastType || "work" });
      startSegTimer(localSettings().lastType || "work", Date.now());
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
      S.resume.armed = false;        // 직접 멈췄다 → 이어서 녹음 대기 없음
      stopSegTimer();
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
      showSaveForm(sheet, out, saveArea, () => { endLocalSession(); closeSheet(); });
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

  // 시트 닫힐 때 정리 — 녹음 중이면 **버리지 않고 담긴 데까지 저장**한다(v1.5.1)
  sheet._onClose = () => {
    stopTimers();
    delRecListener(paint);
    S.recSheet = null;
    S.recStop = null;
    if (R.state === "recording" || R.state === "paused") quickSaveFromSheet();
    stopSegTimer();
  };

  // 상단 바·FAB 에서 이 시트의 녹음을 정지할 때
  S.recStop = () => { if (R.state === "recording" || R.state === "paused") mainBtn.click(); };

  // 탭 하나로 바로 녹음 시작(v1.5.1) — 마이크는 호출한 쪽이 제스처 안에서 이미 열었다
  if (autoStart) {
    try { mainBtn.click(); }
    catch (e) { console.warn("auto start", e); toast("녹음을 시작하지 못했습니다 · 아래 시작 버튼을 눌러 주세요"); }
  }
}

/* 시트를 내리거나 앱을 떠날 때 — 담긴 데까지 저장 */
async function quickSaveFromSheet() {
  const segIndex = S.seg.index;
  const segStart = S.seg.startAt || Date.now();
  const out = await S.recorder.stop();
  stopSegTimer();
  if (!out || !out.blob?.size) { endLocalSession(); return; }
  const endAt = Date.now();
  const label = segmentRangeLabel(segStart, endAt);
  try {
    await saveRecordedOut(out, {
      title: segIndex === 0 ? `새 녹음 ${fmtTime(new Date(segStart).toISOString())}` : `${label} 녹음`,
      type: localSettings().lastType || "work",
      startedAt: new Date(segStart).toISOString(),
      segment: { index: segIndex, start: new Date(segStart).toISOString(), end: new Date(endAt).toISOString(), label },
    });
    endLocalSession();
    toast("녹음을 저장했습니다");
  } catch {
    toast("기기에 보관했습니다 · 연결되면 올라갑니다");
  }
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
      saveSettings({ lastType: type });   // 다음 30분 세그먼트의 유형으로 기억
      await saveRecording({ blob: out.blob, duration: out.duration, mime: out.mime, name: out.name, title, type, speechSec: out.speechSec, speechFromSec: out.speechFromSec });
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

async function saveRecording({ blob, duration, mime, name, title, type, speechSec, speechFromSec }) {
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
    speech_from_sec: speechSec != null && speechFromSec ? Math.round(speechFromSec) : undefined,
    speech_sec_live: speechSec != null ? Math.round(speechSec) : undefined,
    gaps: (S.recorder.gaps || []).length ? S.recorder.gaps.slice() : undefined,
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

  // 0) 기기에 먼저 안전 저장 (업로드가 중간에 끊겨도 살아남게)
  try {
    await store.pendingPut({ id: fileName, blob, name: fileName, parent, mime: mimeFor(ext), at: Date.now(), title, type, duration, speechSec, meta });
  } catch (e) { console.warn("local first save failed", e); }

  let audioFile;
  try {
    audioFile = await uploadWithRetry(blob, fileName, parent, mimeFor(ext));
  } catch (e) {
    // pending 큐에 이미 있다 — 다음 동기화에서 다시 올라간다
    toast("기기에 보관했습니다 · 연결되면 올라갑니다", 3200);
    throw e;
  }
  meta.audio = { file_id: audioFile.id, file_name: fileName, size: blob.size };

  await drive.upload(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), `${base}.json`, parent, { mimeType: "application/json" });
  await store.pendingDel(fileName).catch(() => {});

  S.records.unshift(normalizeRecord(meta, { id: audioFile.id + "-json", name: `${base}.json`, modifiedTime: new Date().toISOString(), base, folderName: "" }, { id: audioFile.id, name: fileName }));
  reindex();
  renderTimeline();
  setTimeout(() => syncNow(), 800);
}

async function uploadWithRetry(blob, fileName, parent, mime) {
  try {
    return await drive.upload(blob, fileName, parent, { mimeType: mime });
  } catch (e) {
    // 오프라인: 기기에 보관했다가 다음 연결 때 재시도 (pendingPut 은 호출 측에서 이미 했다)
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

/* ────────────────────────────────── 예약 녹음 · 유실 방지 ──
   v1.6.2: 예약 바를 매초 innerHTML 로 통째로 다시 그리면 종료 버튼 노드가 손가락이 닿는
   순간 교체되어 click 이벤트가 아예 사라진다("종료를 눌러도 안 꺼짐"). 그래서 골격은
   상태가 바뀔 때 한 번만 만들고, 매초 시간 글자만 갈아끼운다. 클릭은 바 하나에 위임한다. */
function renderAutoBar() {
  const bar = $("#auto-bar");
  if (!bar) return;
  const now = new Date();
  const day = scheduleActiveNow(now);
  const slot = scheduleSlotOf(now, day);
  const muted = !!slot && mutedAutoSlot(autoMute(), slot.id, now.getTime());
  const mode = S.mode === "live" ? (S.auto.on ? "rec" : muted ? "muted" : "") : "";
  if (!mode) {
    if (bar.dataset.mode) { bar.hidden = true; bar.innerHTML = ""; delete bar.dataset.mode; bar.classList.remove("show"); }
    return;
  }
  bar.hidden = false;
  bar.classList.add("show");
  if (bar.dataset.mode !== mode) {
    bar.dataset.mode = mode;
    bar.innerHTML = mode === "rec"
      ? `<span class="ab-dot"></span>
    <div class="ab-main"><b>예약 녹음 중</b><span id="ab-info"></span></div>
    <button class="ab-stop" id="ab-stop" type="button">종료</button>`
      : `<span class="ab-dot muted"></span>
    <div class="ab-main"><b>이번 예약 녹음은 꺼 두었습니다</b><span id="ab-info"></span></div>
    <button class="ab-again" id="ab-again" type="button">다시 켜기</button>`;
  }
  const info = $("#ab-info", bar);
  if (!info) return;
  if (mode === "rec") {
    const el = (Date.now() - S.auto.startedAt) / 1000;
    const speech = S.recorder.speechSec || 0;
    const ready = S.recorder.speechReady;
    info.textContent = `${day?.start || ""}~${day?.end || ""} · ${fmtClock(el)} · 말한 구간 ${ready ? fmtClock(speech) : "확인 중"}${ready && (S.recorder.speechFromSec || 0) > 0 ? ` (측정 ${fmtClock(S.recorder.speechFromSec)}부터)` : ""}`;
  } else {
    const end = new Date(slot.until);
    info.textContent = `${hhmm(slot.startMin)}~${hhmm(slot.endMin)} 예약 · ${hhmm(end.getHours() * 60 + end.getMinutes())}까지 자동 시작 안 함`;
  }
}

/* 예약 바 클릭 — 바가 매초 다시 그려져도 핸들러는 한 번만 걸린다 */
function onAutoBarClick(e) {
  if (e.target.closest(".ab-stop")) { stopAutoRecording({ reason: "manual" }); return; }
  if (e.target.closest(".ab-again")) { resumeAutoSlot(); }
}

/* "다시 켜기" — 억제를 풀고 이 제스처 안에서 바로 시작한다 */
async function resumeAutoSlot() {
  const day = scheduleActiveNow();
  clearAutoMute();
  if (!day) { renderAutoBar(); return; }
  const ok = await startAutoRecording(day);
  renderAutoBar();
  if (!ok) toast("예약 녹음을 다시 켜지 못했습니다 · 화면을 한 번 탭해 주세요", 3200);
}

async function startAutoRecording(day) {
  if (S.mode !== "live" || S.auto.on || S.auto.pending || S.auto.stopping) return false;
  if (S.sheet?._rec) return false;
  if (!recorderIdle()) return false;
  const now = new Date();
  const slot = scheduleSlotOf(now, day || scheduleActiveNow(now));
  if (slot && mutedAutoSlot(autoMute(), slot.id, now.getTime())) return false;   // 사용자가 끈 슬롯
  S.auto.pending = true;
  try {
    // 뒤집어 녹음 대기 중이면 마이크를 계속 들고 있다(다음 엎기에도 바로 시작)
    await S.recorder.start({ vad: localSettings().vad !== false, keepMic: faceDownPref() });
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
  noteRecordingStart(new Date(S.auto.startedAt).toISOString());
  beginLocalSession({ title: `예약 녹음 ${fmtTime(new Date().toISOString())}`, type: S.auto.type });
  startSegTimer(S.auto.type, S.auto.startedAt);
  haptic(12);
  clearInterval(S.auto.timer);
  S.auto.timer = setInterval(renderAutoBar, 1000);
  renderAutoBar();
  toast(`예약 녹음을 시작했습니다${day?.start ? ` (${day.start}~${day.end})` : ""}`);
  return true;
}

async function stopAutoRecording({ reason = "end" } = {}) {
  if (!S.auto.on || S.auto.stopping) return;
  S.auto.stopping = true;
  /* 사용자가 직접 껐다면 저장보다 먼저 억제를 걸어 둔다 — 저장이 늦거나 실패해도
     틱·화면 복귀가 다시 켜지 못하게 (이 순서가 "안 꺼짐"의 핵심 방어선) */
  if (reason === "manual") setAutoMute(scheduleSlotOf(new Date(), scheduleActiveNow()));
  S.resume.armed = false;            // 예약 녹음을 멈추면 '이어서 녹음' 대기도 끝난다
  clearInterval(S.auto.timer);
  S.auto.timer = null;
  stopSegTimer();
  const type = S.auto.type || "work";
  let out = null;
  try {
    // 진행 중인 30분 회전이 있으면 끝나기를 기다린다(그러지 않으면 새 recorder 가 고아로 남는다)
    if (S.seg.rotating) { try { await S.seg.rotating; } catch {} }
    out = await S.recorder.stop();
  } catch (e) {
    console.warn("auto stop failed", e);
    try { S.recorder.cancel(); } catch {}     // 그래도 사용자에게는 확실히 꺼진 상태로
  } finally {
    S.auto.on = false;
    S.auto.stopping = false;
    renderAutoBar();
  }
  const segIndex = S.seg.index;
  const segStart = S.seg.startAt || S.auto.startedAt;
  if (!out || !out.blob?.size) { endLocalSession(); return; }
  const endAt = Date.now();
  const label = segmentRangeLabel(segStart, endAt);
  const title = segIndex === 0
    ? `예약 녹음 ${fmtTime(new Date(segStart).toISOString())}`
    : `${label} 녹음`;
  try {
    await saveRecordedOut(out, {
      title, type,
      startedAt: new Date(segStart).toISOString(),
      segment: { index: segIndex, start: new Date(segStart).toISOString(), end: new Date(endAt).toISOString(), label },
    });
    endLocalSession();
    toast(reason === "end" ? "예약 시간이 끝나 자동 저장했습니다" : "예약 녹음을 저장했습니다 · 이 시간대에는 다시 켜지 않습니다", 3600);
  } catch (e) {
    toast("기기에 보관했습니다 · 연결되면 올라갑니다");
  }
}

function schedTick() {
  if (S.mode !== "live") return;
  const now = new Date();
  const day = scheduleActiveNow(now);
  const slot = scheduleSlotOf(now, day);
  const act = nextAutoAction({
    active: !!day, slotId: slot?.id || "", now: now.getTime(),
    on: S.auto.on, pending: S.auto.pending, stopping: S.auto.stopping,
    busy: !recorderIdle(), failAt: S.auto.failAt, mute: autoMute(),
  });
  if (act === "start") startAutoRecording(day);
  else if (act === "stop") stopAutoRecording({ reason: "end" });
  else renderAutoBar();          // 꺼 둔 슬롯 표시를 새로 그리고, 창이 끝나면 내린다
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
    const wasFace = S.face.active || S.face.pending;
    const wasRes = S.res.on;
    const kindType = wasAuto ? (S.auto.type || "work") : wasRes ? (S.res.type || "work") : (localSettings().lastType || "work");
    clearInterval(S.auto.timer);
    S.auto.timer = null;
    clearInterval(S.res.timer);
    S.res.timer = null;
    stopSegTimer();
    const segIndex = S.seg.index;
    const segStart = S.seg.startAt || Date.now();
    const out = await R.stop();
    S.auto.on = false;
    S.res.on = false;
    renderResBar();
    /* 떠날 때 녹음 중이었다면 돌아왔을 때 이어서 녹음한다(v1.5.1) —
       앱 전환으로 iOS 가 캡처를 멈추므로 그때까지는 반드시 저장하되, 세션은 이어진다. */
    S.resume = { armed: true, kind: wasFace ? "face" : wasAuto ? "auto" : wasRes ? "resume" : "manual", type: kindType, at: Date.now() };
    S.face.active = false;
    S.face.pending = false;
    clearInterval(S.face.timer);
    S.face.timer = null;
    hideSleepOverlay();
    flip.markStopped();
    renderAutoBar();
    if (S.sheet?._rec) closeSheet();
    if (!out || !out.blob?.size) { endLocalSession(); return; }
    const endAt = Date.now();
    const label = segmentRangeLabel(segStart, endAt);
    const title = wasAuto
      ? `예약 녹음 ${fmtTime(new Date(segStart).toISOString())}`
      : `자동 저장 ${fmtTime(new Date(segStart).toISOString())}`;
    await saveRecordingFast({
      blob: out.blob, duration: out.duration, mime: out.mime, title,
      type: wasAuto ? S.auto.type : "work", speechSec: out.speechSec,
      started_at: new Date(segStart).toISOString(),
      segment: { index: segIndex, start: new Date(segStart).toISOString(), end: new Date(endAt).toISOString(), label },
    });
    endLocalSession();
  } catch (e) {
    console.warn("rescue save failed", reason, e);
  } finally {
    _rescueBusy = false;
  }
}

/* 기기 큐에 먼저 넣고, 이어서 드라이브 업로드를 시도한다(성공하면 큐에서 제거) */
async function saveRecordingFast({ blob, duration, mime, title, type = "work", speechSec, started_at = null, segment = null, source = "web" }) {
  if (S.mode !== "live") throw new Error("데모에서는 저장되지 않습니다");
  const ext = extFor(mime || blob.type, "");
  const base = `${stamp()}_${type}_${uid(6)}`;
  const fileName = `${base}.${ext}`;
  const mimeType = mimeFor(ext);
  let parent = null;
  try { parent = await drive.inbox(); } catch {}
  // 1) 로컬 큐(IndexedDB)에 먼저 보관 — 화면이 가려져도 유실되지 않게
  try {
    await store.pendingPut({ id: fileName, blob, name: fileName, parent, mime: mimeType, at: Date.now(), title, type, duration, speechSec, started_at, segment });
  } catch (e) { console.warn("queue failed", e); }
  // 2) 드라이브 업로드 시도 — 실패해도 로컬 큐에 남으므로 배지를 갱신하고 다시 알린다
  if (parent) {
    try {
      await drive.upload(blob, fileName, parent, { mimeType });
      await store.pendingDel(fileName).catch(() => {});
    } catch (e) {
      refreshQueue({ force: true });
      throw e;
    }
  } else {
    refreshQueue({ force: true });
    throw new Error("연결되지 않아 기기에만 보관했습니다");
  }
  refreshQueue({ force: true });
  syncNow().catch(() => {});
  return fileName;
}

/* 대기 중 업로드 재시도 (v1.7)
   오프라인이거나 토큰이 만료되어 드라이브에 못 올린 녹음은 IndexedDB(pending)에 남는다.
   예전에는 동기화가 성공했을 때만 재전송해서, 비행기모드에서 저장한 녹음이 계속 방치됐다.
   이제 온라인·화면 복귀·앱 시작·30초 틱에서 조건을 보고(실패할수록 간격을 늘려) 보낸다. */
let _queueRefreshAt = 0;
async function refreshQueue({ force = false } = {}) {
  if (Date.now() - _queueRefreshAt < 2000 && !force) return;
  _queueRefreshAt = Date.now();
  try {
    const items = await store.pendingAll();
    S.queue.count = items.length;
  } catch { return; }
  renderQueueDot();
}

function renderQueueDot() {
  const el = $("#queue-dot");
  if (!el) return;
  const n = S.queue.count || 0;
  el.hidden = n === 0;
  el.dataset.fails = S.queue.fails ? "1" : "0";
  const num = $("#queue-n", el);
  if (num) num.textContent = n > 9 ? "9+" : String(n);
  el.title = n ? `업로드 대기 ${n}건 · 탭해서 지금 올리기` : "";
  el.setAttribute("aria-label", n ? `업로드 대기 ${n}건` : "업로드 대기 없음");
}

function queueTick(force = false) {
  if (S.mode !== "live") return;
  if (S.queue.busy) return;
  const due = force || queueDue({
    now: Date.now(), lastTry: S.queue.lastTry, fails: S.queue.fails, count: S.queue.count,
    online: navigator.onLine !== false, visible: document.visibilityState === "visible",
  });
  if (due && S.queue.count > 0) { S.queue.lastTry = Date.now(); flushPending().catch(() => {}); }
  else refreshQueue();
}

async function flushPending({ manual = false } = {}) {
  if (S.mode !== "live" || S.queue.busy) return { sent: 0 };
  let items = [];
  try { items = await store.pendingAll(); } catch { return { sent: 0 }; }
  S.queue.count = items.length;
  renderQueueDot();
  if (!items.length) { S.queue.fails = 0; if (manual) toast("대기 중인 업로드가 없습니다"); return { sent: 0 }; }
  S.queue.busy = true;
  let sent = 0;
  try {
    for (const it of items) {
      try {
        const parent = it.parent || await drive.inbox();
        await drive.upload(it.blob, it.name, parent, { mimeType: it.mime });
        await store.pendingDel(it.id);
        sent++;
      } catch { break; }
    }
  } finally { S.queue.busy = false; }
  S.queue.lastTry = Date.now();
  S.queue.fails = sent ? 0 : (S.queue.fails || 0) + 1;
  await refreshQueue({ force: true });
  if (sent) syncNow().catch(() => {});
  if (manual) toast(sent ? `${sent}건을 드라이브에 올렸습니다` : "지금은 올리지 못했습니다 · 연결을 확인해 주세요", 3000);
  return { sent };
}

/* 업로드 대기 목록 — 탭하면 지금 올리기 */
async function openQueueSheet() {
  let items = [];
  try { items = await store.pendingAll(); } catch { items = []; }
  const rows = items.slice(0, 20).map((it) => `<div class="del-row"><span class="dr-t">${esc(fmtDay(it.at))} ${esc(fmtTime(it.at))}</span><span class="dr-n">${esc(it.title || it.name || "녹음")} · ${Math.max(1, Math.round((it.blob?.size || 0) / 1024))}KB</span></div>`).join("");
  const sheet = openSheet({
    title: "업로드 대기",
    sub: items.length ? `${items.length}건이 기기에 보관되어 있습니다 · 연결되면 자동으로 올라갑니다` : "대기 중인 녹음이 없습니다",
    body: `<div class="del-list">${rows || '<div class="del-row muted"><span>없음</span></div>'}</div>
      <p class="note" style="margin-top:12px">녹음은 이미 기기(IndexedDB)에 안전하게 저장되어 있습니다. 지금 올리기를 눌러도 되고, 앱이 알아서 다시 시도합니다.</p>`,
    foot: `<div style="display:flex;gap:8px"><button class="btn btn-ghost btn-block" id="q-close">닫기</button><button class="btn btn-primary btn-block" id="q-retry" ${items.length ? "" : "disabled"}>지금 올리기</button></div>`,
  });
  $("#q-close", sheet).addEventListener("click", () => closeSheet());
  $("#q-retry", sheet).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    await flushPending({ manual: true });
    closeSheet();
  });
}

/* ── 기기에 남은 녹음 복구 ──────────────────────────────
   녹음 중 청크를 IndexedDB 에 적립해 두었으므로, 앱이 강제 종료되거나
   업로드가 실패해도 다음 실행에서 '복구'로 되살릴 수 있다. */
async function checkLocalRecovery() {
  if (S.mode !== "live") return;
  const box = $("#recovery");
  if (!box) return;
  let groups = [], meta = null;
  try {
    groups = await store.partGroups();
    meta = await store.sessionGet();
  } catch { return; }
  const cand = groups.find((g) => g.bytes >= 2000 && (!S.segSession || g.key !== S.segSession.id));
  if (!cand) { box.hidden = true; box.innerHTML = ""; return; }
  const latest = cand.parts[cand.parts.length - 1];
  const startedAt = meta && meta.id === cand.key ? meta.startedAt : cand.at;
  const title = (meta && meta.id === cand.key ? meta.title : "") || "녹음";
  const dur = Math.round(cand.bytes / 8000); // 64kbps 기준 대략치
  box.hidden = false;
  box.innerHTML = `<div class="rec-card">
      <div class="rc-main"><b>저장되지 않은 녹음이 있습니다</b><span>${esc(title)} · 약 ${fmtClock(dur)} · ${esc(fmtDay(startedAt))} ${esc(fmtTime(startedAt))}</span></div>
      <button class="db-btn" id="rec-ok">복구</button>
      <button class="db-btn" id="rec-no">버리기</button>
    </div>`;
  $("#rec-ok", box).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "복구 중…";
    try {
      const type = cand.parts[0]?.blob?.type || "audio/mp4";
      const blob = new Blob(cand.parts.map((p) => p.blob), { type });
      if (!blob.size) throw new Error("복구할 데이터가 없습니다");
      const duration = await probeDuration(blob);
      await saveRecordingFast({
        blob, duration, mime: type,
        title: `${title} (복구)`,
        type: (meta && meta.id === cand.key && meta.type) || "work",
        started_at: startedAt ? new Date(startedAt).toISOString() : null,
      });
      await store.partClearGroup(cand.key);
      if (meta && meta.id === cand.key) await store.sessionDel();
      box.hidden = true; box.innerHTML = "";
      toast("기기에 있던 녹음을 저장했습니다");
      checkLocalRecovery().catch(() => {});
    } catch (err) {
      btn.disabled = false; btn.textContent = "복구";
      toast("복구하지 못했습니다: " + (err.message || err));
    }
  });
  $("#rec-no", box).addEventListener("click", async () => {
    await store.partClearGroup(cand.key).catch(() => {});
    if (meta && meta.id === cand.key) await store.sessionDel().catch(() => {});
    box.hidden = true; box.innerHTML = "";
    toast("임시 저장을 지웠습니다");
    checkLocalRecovery().catch(() => {});
  });
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
