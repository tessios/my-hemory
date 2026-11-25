/* 브라우저 녹음 (MediaRecorder) + 오디오 레벨 + 화면 꺼짐 방지 + 무음(VAD) 게이트
   · Wake Lock: 녹음 중 화면이 자동으로 꺼지지 않게 잠급니다(iOS Safari 16.4+, Chrome·Edge·안드로이드).
     화면이 잠기거나 전화가 오면 브라우저가 마이크를 끊는 것은 그대로입니다(웹의 한계).
   · VAD: AnalyserNode 의 RMS 로 발화 구간을 판별해, 침묵 구간은 게인 0 으로 막아 소리를 담지 않습니다.
     (웹 API 로는 컨테이너 길이를 줄일 수 없으므로, 침묵은 '무음으로' 남기고 실제 말한 구간만 전사합니다) */
/* ── 마이크 한 벌 계속 들고 있기(mic lease) ──────────────────────
   iOS Safari / 홈 화면 앱은 **캡처가 이어지는 동안에만** 마이크 권한을 유지한다.
   녹음이 끝날 때 트랙을 stop() 하면 곧(수십 초~1분) 권한이 풀려, 사용자 터치 없이
   센서(엎기)로 시작하는 다음 녹음의 getUserMedia 가 NotAllowedError 로 막힌다.
   (WebKit bug 215884 — "capture is not ongoing 이면 prompt 가 다시 뜬다")
   그래서 앱이 화면에 떠 있는 동안은 스트림을 닫지 않고 그대로 들고 있다가,
   녹음마다 **MediaRecorder 만 새로 만든다**. */
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

const mic = { stream: null, state: "idle", boundTrack: null, listeners: new Set() };

/* 상태가 바뀔 때(끊김·복구·해제) 화면에 알린다 */
export function onMicChange(fn) { mic.listeners.add(fn); return () => mic.listeners.delete(fn); }

export function micTrack() { return mic.stream?.getAudioTracks?.()[0] || null; }
export function micHeld() { return !!mic.stream; }
export function micStatus() {
  const t = micTrack();
  return {
    state: mic.state,                        // idle | live | interrupted | lost | denied | unsupported
    held: !!mic.stream,
    live: !!t && t.readyState === "live" && !t.muted,
    readyState: t ? t.readyState : "none",
    muted: !!t?.muted,
    label: t?.label || "",
  };
}

function micNotify() {
  const s = micStatus();
  for (const fn of mic.listeners) { try { fn(s); } catch {} }
}

/* 전화·Siri·화면 잠금으로 iOS 가 오디오 세션을 끊으면 트랙에 mute/ended 가 온다 */
function bindMicTrack(stream) {
  const t = stream?.getAudioTracks?.()[0];
  if (!t || mic.boundTrack === t) return;
  mic.boundTrack = t;
  const sync = () => {
    const live = t.readyState === "live" && !t.muted;
    const next = live ? "live" : t.readyState === "ended" ? "lost" : "interrupted";
    if (next !== mic.state) { mic.state = next; micNotify(); }
  };
  try {
    t.addEventListener?.("mute", sync);
    t.addEventListener?.("unmute", sync);
    t.addEventListener?.("ended", sync);
  } catch {}
}

/* 마이크를 연다. 이미 살아 있는 스트림이 있으면 그대로 재사용한다(재사용이 핵심).
   동시에 두 번 불려도(첫 탭에서 센서·마이크 핸들러가 같이 도는 경우) getUserMedia 는 한 번만 나간다. */
let micPending = null;
export function acquireMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    mic.state = "unsupported"; micNotify();
    return Promise.resolve({ ok: false, reason: "unsupported" });
  }
  const t = micTrack();
  if (t && t.readyState === "live" && !t.muted) {
    if (mic.state !== "live") { mic.state = "live"; micNotify(); }
    return Promise.resolve({ ok: true, reused: true, stream: mic.stream });
  }
  if (micPending) return micPending;
  micPending = openMic().finally(() => { micPending = null; });
  return micPending;
}

async function openMic() {
  // 죽었거나 끊긴 트랙은 버리고 새로 연다
  if (mic.stream) {
    try { mic.stream.getTracks().forEach((x) => x.stop()); } catch {}
    mic.stream = null; mic.boundTrack = null;
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    mic.stream = s;
    mic.state = "live";
    bindMicTrack(s);
    micNotify();
    return { ok: true, reused: false, stream: s };
  } catch (e) {
    const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
    mic.state = denied ? "denied" : "lost";
    micNotify();
    return { ok: false, reason: denied ? "denied" : "error", error: e?.name || "error" };
  }
}

/* 마이크를 완전히 닫는다(뒤집어 녹음 끄기·앱을 떠날 때) */
export function releaseMic() {
  if (mic.stream) { try { mic.stream.getTracks().forEach((x) => x.stop()); } catch {} }
  mic.stream = null;
  mic.boundTrack = null;
  mic.state = "idle";
  micNotify();
}

/* 마이크 권한 미리 받기 — 반드시 사용자 탭 핸들러에서 호출한다.
   iOS 는 처음 한 번 허용해야 하며, 허용 전에는 센서(엎기)로 시작한 녹음이 조용히 막힌다.
   v1.4.1: 연 스트림을 **닫지 않고** 대여 상태로 남긴다(닫으면 iOS 가 권한을 푼다). */
export async function prewarmMic() {
  const r = await acquireMic();
  return r.ok ? "ok" : r.reason === "denied" ? "denied" : r.reason === "unsupported" ? "unsupported" : "error";
}

/* 오디오 컨텍스트를 제스처 안에서 깨워 둔다.
   iOS 는 제스처 밖에서 만든 AudioContext 가 'suspended' 로 남아 VAD 레벨 측정이 꺼진다.
   한 번 깨운 컨텍스트는 이후(센서·예약으로 시작한 녹음에서도) 계속 쓸 수 있다. */
let sharedCtx = null;
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AC();
    sharedCtx.resume?.().catch(() => {});
    return sharedCtx;
  } catch { return null; }
}

export class Recorder {
  constructor() {
    this.media = null;
    this.rec = null;
    this.chunks = [];
    this.ctx = null;
    this._ownCtx = false;
    this.src = null;
    this.analyser = null;
    this.stream = null;
    this.startedAt = 0;
    this.elapsed = 0;
    this.state = "idle"; // idle | recording | paused | done
    this.mime = "";

    /* 화면 꺼짐 방지 */
    this.wake = "off"; // off | held | unsupported | denied | released
    this.wakeSentinel = null;
    this._onVis = null;

    /* VAD */
    this.vad = false;
    this.gate = null;
    this.dest = null;
    this.speaking = false;
    this.speechSec = 0;
    this._open = false;
    this._noise = 0.006;
    this._silentMs = 0;
    this._lastTick = 0;
    this._vadTimer = null;

    /* v1.4: 신호 감시 · 세그먼트(30분) 교체 · 청크 적립 */
    this.recStream = null;     // MediaRecorder 에 물린 스트림(회전 시 재사용)
    this.keepMic = true;       // 녹음이 끝나도 마이크 스트림을 닫지 않는다(v1.4.1)
    this.ctxRunning = true;    // AudioContext 가 실제로 돌고 있는가(아니면 레벨·VAD 를 믿지 않는다)
    this.maxRms = 0;           // 이 구간에서 측정된 최대 레벨
    this.noSignalMs = 0;       // 완전 무신호가 이어진 시간
    this._sigAlerted = false;  // 무신호 경고를 이미 띄웠는가
    this._levelTimer = null;
    this.onPart = null;        // (chunk, index) => void  — 로컬 적립용
    this.onSignalAlert = null; // ({ ms, track }) => void — 마이크 신호 끊김 알림

    /* 상태 알림: { wake, vad, speaking, speechSec, state } */
    this.onStatus = null;
  }

  static get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  static get wakeSupported() {
    return !!navigator.wakeLock?.request;
  }

  static get vadSupported() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  _notify() {
    try {
      this.onStatus?.({
        wake: this.wake,
        vad: this.vad,
        speaking: this.speaking,
        speechSec: this.speechSec,
        state: this.state,
      });
    } catch {}
  }

  _pickMime() {
    const cands = ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
    for (const c of cands) if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
    return "";
  }

  /* ── 화면 꺼짐 방지 (Wake Lock) ─────────────────────────── */
  async _acquireWakeLock() {
    if (!Recorder.wakeSupported) { this.wake = "unsupported"; this._notify(); return false; }
    try {
      this.wakeSentinel = await navigator.wakeLock.request("screen");
      this.wake = "held";
      this.wakeSentinel?.addEventListener?.("release", () => {
        this.wakeSentinel = null;
        if (this.state === "recording" || this.state === "paused") this.wake = "released";
        else this.wake = "off";
        this._notify();
      });
      this._notify();
      return true;
    } catch {
      // 화면을 직접 잠갔거나, 저전력 모드·탭 비활성 상태 등
      this.wake = "denied";
      this._notify();
      return false;
    }
  }

  async _releaseWakeLock() {
    const s = this.wakeSentinel;
    this.wakeSentinel = null;
    this.wake = "off";
    try { await s?.release?.(); } catch {}
    this._notify();
  }

  /* ── VAD (발화 구간 게이트) ─────────────────────────────── */
  _rms() {
    const a = this.analyser;
    if (!a) return 0;
    const buf = new Uint8Array(a.fftSize);
    a.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }

  _setGate(open) {
    this._open = !!open;
    const g = this.gate?.gain;
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(open ? 1 : 0, t + 0.02); // 클릭·튐 방지
    } catch {
      g.value = open ? 1 : 0;
    }
  }

  _vadLoop() {
    clearInterval(this._vadTimer);
    this._lastTick = Date.now();
    this._vadTimer = setInterval(() => this._vadTick(), 40);
    this._vadTick();
  }

  _vadTick() {
    const now = Date.now();
    const dt = Math.min(0.2, Math.max(0, (now - this._lastTick) / 1000));
    this._lastTick = now;
    if (this.state !== "recording") return; // 사용자가 일시정지·정지한 동안은 세지 않음

    const rms = this._rms();
    const thr = Math.max(this._noise * 1.8, 0.006);
    const before = this.speaking;

    if (rms > thr) {
      this._silentMs = 0;
      this.speaking = true;
      if (!this._open) this._setGate(true);
    } else {
      this._silentMs += dt * 1000;
      if (this.speaking && this._silentMs > 700) this.speaking = false; // 말끝이 잘리지 않도록 0.7초 여운
      if (!this.speaking) {
        // 침묵 중에만 주변 소음 바닥을 천천히 학습(에어컨·도로 소음 적응)
        this._noise = Math.max(0.0005, Math.min(0.05, this._noise * 0.97 + rms * 0.03));
        if (this._open && this._silentMs > 700) this._setGate(false); // 여운이 끝난 침묵은 담지 않는다
      }
    }

    if (this._open) this.speechSec += dt;
    if (before !== this.speaking) this._notify();
  }

  /* ── 신호 감시 ────────────────────────────────────────────
     VAD 와 별개로 항상 레벨을 재서 (a) 최대 레벨 (b) 완전 무신호 지속 시간을 본다.
     마이크가 실제로 죽으면(화면 잠금·백그라운드 전환 등) RMS 가 0 근처에 머문다. */
  _peakRms() {
    const a = this.analyser;
    if (!a) return 0;
    const buf = new Uint8Array(a.fftSize);
    a.getByteTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs((buf[i] - 128) / 128);
      if (v > peak) peak = v;
      sum += v * v;
    }
    return Math.max(Math.sqrt(sum / buf.length), peak * 0.6);
  }

  _trackHealth() {
    const t = this.stream?.getAudioTracks?.()[0];
    if (!t) return null;
    return { readyState: t.readyState, muted: !!t.muted, enabled: !!t.enabled, label: t.label || "" };
  }

  /* 전화·Siri·화면 잠금으로 iOS 가 오디오 세션을 끊으면 트랙에 mute/ended 가 온다. */
  _bindTrackWatch() {
    const t = this.stream?.getAudioTracks?.()[0];
    if (!t) return;
    this._onTrackMute = () => { try { this.onSignalAlert?.({ ms: 0, track: this._trackHealth() }); } catch {} };
    this._onTrackEnd = () => { try { this.onSignalAlert?.({ ms: 0, track: this._trackHealth() }); } catch {} };
    try {
      t.addEventListener("mute", this._onTrackMute);
      t.addEventListener("ended", this._onTrackEnd);
    } catch {}
  }

  _unbindTrackWatch() {
    const t = this.stream?.getAudioTracks?.()[0];
    if (!t) return;
    try { t.removeEventListener("mute", this._onTrackMute); } catch {}
    try { t.removeEventListener("ended", this._onTrackEnd); } catch {}
  }

  _startLevelLoop() {
    clearInterval(this._levelTimer);
    this._levelTimer = setInterval(() => this._levelTick(), 200);
  }

  _levelTick() {
    if (this.state !== "recording") return;
    if (!this.ctxRunning) return;               // 잠든 컨텍스트의 0 레벨로 무음 판정하지 않는다
    const rms = this._peakRms();
    this.maxRms = Math.max(this.maxRms ?? 0, rms);
    if (rms <= 0.0022) this.noSignalMs += 200;
    else this.noSignalMs = 0;
    if (this.noSignalMs >= 3000 && !this._sigAlerted) {
      this._sigAlerted = true;
      // 마이크가 조용한 게 아니라 죽은 경우엔 VAD 게이트를 열어 두는 편이 낫다(원음 보존).
      try { this._setGate(true); } catch {}
      try { this.onSignalAlert?.({ ms: this.noSignalMs, track: this._trackHealth() }); } catch {}
    }
  }

  /* ── 녹음 ───────────────────────────────────────────────── */
  async start({ vad = false, keepMic = true } = {}) {
    if (!Recorder.supported) throw new Error("이 브라우저에서는 녹음을 지원하지 않습니다.");
    // v1.4.1: 새 스트림을 열지 않고 대여 중인 마이크를 그대로 쓴다.
    //   (iOS 는 트랙을 닫으면 권한을 풀어, 사용자 터치 없는 다음 시작을 막는다)
    this.keepMic = !!keepMic;
    const got = await acquireMic();
    if (!got.ok) {
      const err = new Error(got.reason === "denied" ? "마이크 권한이 필요합니다" : "마이크를 열지 못했습니다");
      err.code = got.reason || "error";
      throw err;
    }
    this.stream = got.stream;
    this.mime = this._pickMime();

    const AC = window.AudioContext || window.webkitAudioContext;
    const shared = unlockAudio();           // 제스처로 깨워 둔 컨텍스트가 있으면 그대로 쓴다
    this._ownCtx = !shared;
    this.ctx = shared || new AC();
    try { await this.ctx.resume?.(); } catch {}
    // 사용자 제스처 없이(엎어서) 시작하면 AudioContext 가 suspended 로 남을 수 있다.
    //   그때 레벨 측정은 0 이 되므로 '무음'이라고 단정하지 않는다(원음은 스트림에서 그대로 담긴다).
    this.ctxRunning = this.ctx.state === "running";
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.src = src;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.2;
    src.connect(this.analyser);

    // v1.4: 녹음은 **마이크 원본 스트림**을 그대로 담는다.
    //   예전에는 VAD 게이트(src→gain→MediaStreamDestination)를 거친 스트림을 녹음했는데,
    //   사용자 동작 없이(엎어서) 시작하면 iOS 가 AudioContext 를 suspended 로 두어
    //   destination 스트림이 **무음을 출력**했고, 그게 그대로 저장됐다(18초/6.3kbps 사고).
    //   이제 VAD 는 녹음 경로에 끼지 않고 '말한 구간(speechSec)'만 세는 참고 정보다.
    //   침묵 제거는 전사 단계(whisper VAD)에서 한다.
    this.vad = !!vad && Recorder.vadSupported && this.ctxRunning;
    const recStream = this.stream;
    this.speaking = false;
    this.speechSec = 0;
    this._open = true;
    this._silentMs = 0;
    this._noise = 0.006;

    this.recStream = recStream;
    this.rec = new MediaRecorder(recStream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        this.chunks.push(e.data);
        try { this.onPart?.(e.data, this.chunks.length); } catch {}
      }
    };
    this.rec.start(1000);

    this.startedAt = Date.now();
    this.elapsed = 0;
    this.maxRms = this.ctxRunning ? 0 : null;   // null = 레벨을 못 쟀다
    this.noSignalMs = 0;
    this._sigAlerted = false;
    this.state = "recording";

    // iOS 웹앱: 오디오 세션을 '재생+녹음'으로 명시해 두면 화면 전환 시 입력이 덜 끊긴다.
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch {}
    this._startLevelLoop();
    this._bindTrackWatch();

    await this._acquireWakeLock();
    this._onVis = () => {
      // 화면이 다시 보이면 잠금을 다시 건다(백그라운드에 들어가면 브라우저가 잠금을 푼다)
      if (document.visibilityState === "visible" && this.state !== "idle" && this.state !== "done" && this.wake !== "held") {
        this._acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", this._onVis);
    if (this.vad) this._vadLoop();
    this._notify();
  }

  level() {
    if (!this.analyser) return 0;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
  }

  elapsedSec() {
    if (this.state === "recording") return (Date.now() - this.startedAt) / 1000;
    return this.elapsed;
  }

  pause() {
    if (this.rec?.state === "recording") {
      this.rec.pause();
      this.elapsed += (Date.now() - this.startedAt) / 1000;
      this.state = "paused";
      this.speaking = false;
      this._notify();
    }
  }

  resume() {
    if (this.rec?.state === "paused") {
      this.rec.resume();
      this.startedAt = Date.now();
      this.state = "recording";
      // 다시 시작할 때는 열어 두고 VAD 가 판단하게 한다
      this._lastTick = Date.now();
      this._silentMs = 0;
      if (this.vad) this._setGate(true);
      this._notify();
    }
  }

  _teardown() {
    clearInterval(this._vadTimer);
    this._vadTimer = null;
    this._unbindTrackWatch();
    clearInterval(this._levelTimer);
    this._levelTimer = null;
    try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch {}
    if (this._onVis) { document.removeEventListener("visibilitychange", this._onVis); this._onVis = null; }
    this._releaseWakeLock();
    // v1.4.1: 마이크 스트림은 '대여'가 들고 있다 — 여기서 닫지 않는다.
    //   닫으면 iOS 가 마이크 권한을 풀어, 다음 엎기에서 사용자 터치 없이 열 수 없다.
    if (!this.keepMic) releaseMic();
    try { this.src?.disconnect(); } catch {}
    try { this.gate?.disconnect(); } catch {}
    try { this.dest?.disconnect?.(); } catch {}
    // 공유 컨텍스트는 닫지 않는다(다음 녹음에서 다시 쓰려고 깨워 둔 것)
    if (this._ownCtx) { try { this.ctx?.close(); } catch {} }
    this.rec = null; this.stream = null; this.analyser = null; this.ctx = null; this.gate = null; this.dest = null; this.src = null; this.recStream = null;
  }

  /* 30분 세그먼트 교체 — 스트림·게이트·워크락은 그대로 두고 MediaRecorder 만 새로 만든다.
     (새 스트림을 열면 사용자 제스처 없이는 막히므로 절대 닫지 않는다) */
  async rotate() {
    if (!this.rec || this.state !== "recording" || !this.recStream) return null;
    const duration = (Date.now() - this.startedAt) / 1000;
    this.elapsed += duration;
    const speech = this.vad ? Math.min(this.speechSec, duration) : null;
    const maxRms = this.maxRms;
    const silentAlerted = this._sigAlerted;
    const prev = this.rec;
    const prevChunks = this.chunks;
    await new Promise((resolve) => {
      prev.onstop = () => resolve();
      try { if (prev.state !== "inactive") prev.stop(); else resolve(); } catch { resolve(); }
    });
    const type = this.mime || "audio/mp4";
    const blob = new Blob(prevChunks, { type });

    this.chunks = [];
    this.speechSec = 0;
    this.maxRms = this.ctxRunning ? 0 : null;
    this.noSignalMs = 0;
    this._sigAlerted = false;
    this.elapsed = 0;
    this.rec = new MediaRecorder(this.recStream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : undefined);
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        this.chunks.push(e.data);
        try { this.onPart?.(e.data, this.chunks.length); } catch {}
      }
    };
    this.rec.start(1000);
    this.startedAt = Date.now();
    this.state = "recording";
    if (this.vad) { this._lastTick = Date.now(); this._setGate(true); }
    this._notify();
    return { blob, duration, mime: type, vad: this.vad, speechSec: speech, maxRms, silentAlerted };
  }

  async stop() {
    if (!this.rec) return null;
    if (this.state === "recording") this.elapsed += (Date.now() - this.startedAt) / 1000;
    const duration = this.elapsed;
    const speech = this.vad ? Math.min(this.speechSec, duration) : null;
    const rec = this.rec;
    await new Promise((resolve) => {
      rec.onstop = () => resolve();
      if (rec.state !== "inactive") rec.stop();
      else resolve();
    });
    const type = this.mime || "audio/mp4";
    const blob = new Blob(this.chunks, { type });
    const maxRms = this.maxRms;
    const silentAlerted = this._sigAlerted;
    this.state = "done";
    this._teardown();
    this._notify();
    return { blob, duration, mime: type, vad: this.vad, speechSec: speech, maxRms, silentAlerted };
  }

  cancel() {
    clearInterval(this._levelTimer);
    this._levelTimer = null;
    this.ctxRunning = true;
    if (this.rec) { try { this.rec.onstop = null; this.rec.stop(); } catch {} }
    this._teardown();
    this.state = "idle";
    this.elapsed = 0;
    this.speechSec = 0;
    this.speaking = false;
    this._open = false;
    this._notify();
  }
}

export function pickAudioFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.m4a,.mp3,.wav,.aac,.caf,.ogg,.opus";
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

export function extFor(mime, name = "") {
  const m = (mime || "").toLowerCase();
  if (name.includes(".")) return name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("webm")) return "webm";
  return "m4a";
}

export function mimeFor(ext) {
  const e = (ext || "").toLowerCase();
  return ({ m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", caf: "audio/x-caf", ogg: "audio/ogg", opus: "audio/ogg", webm: "audio/webm" })[e] || "audio/mp4";
}

export function probeDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("audio");
    let done = false;
    const finish = (v) => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(v || 0); } };
    a.preload = "metadata";
    a.onloadedmetadata = () => finish(a.duration && isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => finish(0);
    setTimeout(() => finish(a.duration && isFinite(a.duration) ? a.duration : 0), 4000);
    a.src = url;
  });
}
