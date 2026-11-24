/* 브라우저 녹음 (MediaRecorder) + 오디오 레벨 + 화면 꺼짐 방지 + 무음(VAD) 게이트
   · Wake Lock: 녹음 중 화면이 자동으로 꺼지지 않게 잠급니다(iOS Safari 16.4+, Chrome·Edge·안드로이드).
     화면이 잠기거나 전화가 오면 브라우저가 마이크를 끊는 것은 그대로입니다(웹의 한계).
   · VAD: AnalyserNode 의 RMS 로 발화 구간을 판별해, 침묵 구간은 게인 0 으로 막아 소리를 담지 않습니다.
     (웹 API 로는 컨테이너 길이를 줄일 수 없으므로, 침묵은 '무음으로' 남기고 실제 말한 구간만 전사합니다) */
/* 마이크 권한 미리 받기 — 반드시 사용자 탭 핸들러에서 호출한다.
   iOS 는 처음 한 번 허용해야 하며, 허용 전에는 센서(엎기)로 시작한 녹음이 조용히 막힌다. */
export async function prewarmMic() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return "ok";
  } catch (e) {
    return e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "denied" : "error";
  }
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
    const rms = this._peakRms();
    this.maxRms = Math.max(this.maxRms, rms);
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
  async start({ vad = false } = {}) {
    if (!Recorder.supported) throw new Error("이 브라우저에서는 녹음을 지원하지 않습니다.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.mime = this._pickMime();

    const AC = window.AudioContext || window.webkitAudioContext;
    const shared = unlockAudio();           // 제스처로 깨워 둔 컨텍스트가 있으면 그대로 쓴다
    this._ownCtx = !shared;
    this.ctx = shared || new AC();
    try { await this.ctx.resume?.(); } catch {}
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
    this.vad = !!vad && Recorder.vadSupported;
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
    this.maxRms = 0;
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
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
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
    this.maxRms = 0;
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
