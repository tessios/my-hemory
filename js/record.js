/* 브라우저 녹음 (MediaRecorder) + 오디오 레벨 */
export class Recorder {
  constructor() {
    this.media = null;
    this.rec = null;
    this.chunks = [];
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.startedAt = 0;
    this.elapsed = 0;
    this.state = "idle"; // idle | recording | paused | done
    this.mime = "";
  }

  static get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  _pickMime() {
    const cands = ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
    for (const c of cands) if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
    return "";
  }

  async start() {
    if (!Recorder.supported) throw new Error("이 브라우저에서는 녹음을 지원하지 않습니다.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.mime = this._pickMime();
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);

    this.startedAt = Date.now();
    this.elapsed = 0;
    this.state = "recording";
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
    }
  }

  resume() {
    if (this.rec?.state === "paused") {
      this.rec.resume();
      this.startedAt = Date.now();
      this.state = "recording";
    }
  }

  async stop() {
    if (!this.rec) return null;
    if (this.state === "recording") this.elapsed += (Date.now() - this.startedAt) / 1000;
    const duration = this.elapsed;
    const rec = this.rec;
    await new Promise((resolve) => {
      rec.onstop = () => resolve();
      if (rec.state !== "inactive") rec.stop();
      else resolve();
    });
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.ctx?.close(); } catch {}
    const type = this.mime || "audio/mp4";
    const blob = new Blob(this.chunks, { type });
    this.rec = null; this.stream = null; this.analyser = null; this.ctx = null;
    this.state = "done";
    return { blob, duration, mime: type };
  }

  cancel() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx?.close(); } catch {}
    this.rec = null; this.stream = null; this.analyser = null; this.ctx = null;
    this.state = "idle";
    this.elapsed = 0;
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
