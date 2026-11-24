/* 뒤집어(엎어) 자동 녹음 — 아이폰 센서 감지
   ─────────────────────────────────────────────────────────────
   아이폰(iOS 13+)은 `DeviceMotionEvent` / `DeviceOrientationEvent` 마다
   requestPermission() 을 "사용자 탭 안에서, 곧바로" 호출해야 이벤트가 들어온다.
   또 그 허용은 페이지(앱 실행) 단위라서 앱을 새로 열면 다시 한 번 필요하다.
   이 모듈은 그 흐름과 '엎었다/들었다' 판정을 한 곳에서 맡는다.

   판정은 두 신호를 같이 쓴다.
   · 중력 가속도 z 성분(accelerationIncludingGravity.z) — 폰을 엎으면 |z| ≈ 9.8,
     화면이 위면 부호가 반대. 평평한 책상 위에서 가장 정확하고 짐벌락이 없다.
   · 방향 beta — 화면이 위로 평평하면 0°, 엎으면 ±180°. z 신호가 없을 때 대신 쓴다.
   기기마다 z 부호 규약이 달라서(아이폰 -9.8 / 안드로이드 +9.8), 화면이 위로
   평평한 순간을 만나면 부호를 스스로 맞춘다(zUp). */

export const FLIP_HOLD_MS = 1500;    // 엎어 둔 채 이 시간 유지되면 녹음 시작
export const FLIP_RELEASE_MS = 600;  // 들고 나서 이 시간 유지되면 정지·저장
export const G_EDGE = 6.0;           // |z| 임계 (엎으면 약 9.8)
export const STALE_MS = 2500;        // 마지막 센서 이벤트가 이보다 오래되면 '신호 없음'

/* 순수 판정 함수 — DOM 없이 단위 테스트할 수 있게 분리 */
export function judgePose({ beta = null, gz = null } = {}, cal = {}) {
  const res = { pose: "tilt", zUp: cal.zUp ?? -1, beta: beta ?? null, gz: gz ?? null };
  const zOk = gz != null && Number.isFinite(gz) && Math.abs(gz) > G_EDGE;
  const bOk = beta != null && Number.isFinite(beta);

  // 화면이 위를 보고 평평하면(z 큼 + beta≈0) 이 기기의 z 부호 규약을 학습한다
  if (zOk && bOk && Math.abs(beta) < 45) res.zUp = gz > 0 ? 1 : -1;

  if (zOk) {
    const down = gz * res.zUp < 0;                     // 화면이 아래를 향함
    // 방향 값이 명백히 '위'(beta≈0)인데 z가 아래를 말하면 규약이 반대인 기기 → 시작하지 않는다
    res.pose = down ? (bOk && Math.abs(beta) < 50 ? "tilt" : "down") : "up";
    return res;
  }
  if (bOk) {
    const b = Math.abs(beta);
    res.pose = b > 145 ? "down" : b < 45 ? "up" : "tilt";
    return res;
  }
  res.pose = "none";
  return res;
}

export class FlipWatcher {
  constructor({ onStart, onStop, onState, onSample } = {}) {
    this.onStart = onStart;     // async () => boolean | undefined  (false 면 실패)
    this.onStop = onStop;       // (reason) => void
    this.onState = onState;     // (state) => void
    this.onSample = onSample;   // (watcher) => void  — 설정 화면 실시간 표시용

    this.armed = false;         // 사용자가 이 기능을 켜 두었는가
    this.probe = false;         // 녹음 없이 센서 값만 보고 싶을 때(설정 화면)
    this.listening = false;
    this.starting = false;

    this.perm = this._needsPrompt() ? "unknown" : "not-required";
    this.permDetail = {};
    this.askedThisLoad = false;

    this.listenAt = 0;
    this.last = { beta: null, gz: null, t: 0 };
    this.zUp = -1;              // 화면이 위일 때의 z 부호(아이폰 -1)
    this.pose = "none";
    this.active = false;
    this.startedAt = 0;
    this.downSince = 0;
    this.upSince = 0;
    this.blockUntilRelease = false;
    this.state = "off";

    this._timer = null;
    this._onMotion = (e) => this._absorbMotion(e);
    this._onOrient = (e) => this._absorbOrient(e);
  }

  get supported() {
    return typeof window !== "undefined" && !!(window.DeviceMotionEvent || window.DeviceOrientationEvent);
  }

  _needsPrompt() {
    if (typeof window === "undefined") return false;
    return typeof window.DeviceMotionEvent?.requestPermission === "function" ||
      typeof window.DeviceOrientationEvent?.requestPermission === "function";
  }

  get granted() { return this.perm === "granted" || this.perm === "not-required"; }
  get hasSignal() { return !!this.last.t && Date.now() - this.last.t < STALE_MS; }
  get elapsedSec() { return this.active && this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0; }

  /* 반드시 사용자 탭/클릭 핸들러에서 곧바로 호출한다.
     (await 로 다른 일을 먼저 하면 iOS 가 '제스처 없음'으로 거부한다) */
  async requestPermission() {
    if (!this.supported) { this.perm = "unsupported"; this._sync(); return { ok: false, reason: "unsupported" }; }
    if (!this._needsPrompt()) { this.perm = "not-required"; this._sync(); return { ok: true }; }
    if (this.perm === "granted") { this._sync(); return { ok: true }; }

    this.askedThisLoad = true;
    const ask = async (Ctor) => {
      try {
        const p = Ctor.requestPermission();
        if (!p || typeof p.then !== "function") return typeof p === "string" ? p : "error";
        // 권한 창이 응답하지 않는 브라우저도 있어서 기다림에 한도를 둔다
        return await Promise.race([
          p.then((v) => (typeof v === "string" ? v : "error")).catch((e) => "error:" + (e?.name || "error")),
          new Promise((r) => setTimeout(() => r("timeout"), 8000)),
        ]);
      } catch (e) { return "error:" + (e?.name || "error"); }
    };
    const detail = {};
    if (typeof window.DeviceMotionEvent?.requestPermission === "function") detail.motion = await ask(window.DeviceMotionEvent);
    if (typeof window.DeviceOrientationEvent?.requestPermission === "function") detail.orientation = await ask(window.DeviceOrientationEvent);
    this.permDetail = detail;
    const vals = Object.values(detail);
    const granted = vals.includes("granted");
    const denied = vals.includes("denied") || vals.some((v) => String(v).startsWith("error:NotAllowed"));
    this.perm = granted ? "granted" : denied ? "denied" : "unknown";
    // 응답이 없어도 감시는 켠다 — 이벤트가 들어오면 아래 _absorb* 에서 허용됨으로 올린다
    if (!denied) this.start();
    this._sync();
    return {
      ok: granted,
      reason: granted ? "granted" : denied ? "denied" : vals.includes("timeout") ? "timeout" : "unknown",
      detail,
    };
  }

  /* 스위치를 켤 때: 권한 → 감시 시작. (마이크 예열은 호출한 쪽에서) */
  async enable() {
    const p = await this.requestPermission();
    if (!p.ok) return p;
    this.armed = true;
    this.start();
    return { ok: true, detail: p.detail };
  }

  disable() {
    this.armed = false;
    this.probe = false;
    this.active = false;
    this.startedAt = 0;
    this.blockUntilRelease = false;
    this.downSince = this.upSince = 0;
    this._stopListening();
    this._sync();
  }

  setArmed(on) {
    this.armed = !!on;
    if (!on) {
      this.active = false;
      this.blockUntilRelease = false;
      this.downSince = this.upSince = 0;
      if (!this.probe) this._stopListening();
    }
    this._sync();
  }

  /* 설정 화면에서 센서 값만 보여 주고 싶을 때(녹음은 하지 않음) */
  setProbe(on) {
    this.probe = !!on;
    if (on && this.granted && !this.listening) this.start();
    if (!on && !this.armed) this._stopListening();
    this._sync();
  }

  start() {
    if (this.listening || !this.supported) { this._sync(); return; }
    this.listening = true;
    this.listenAt = Date.now();
    window.addEventListener("devicemotion", this._onMotion, true);
    window.addEventListener("deviceorientation", this._onOrient, true);
    clearInterval(this._timer);
    this._timer = setInterval(() => this.evaluate(), 100);
    this._sync();
  }

  _stopListening() {
    if (!this.listening) { clearInterval(this._timer); this._timer = null; return; }
    this.listening = false;
    window.removeEventListener("devicemotion", this._onMotion, true);
    window.removeEventListener("deviceorientation", this._onOrient, true);
    clearInterval(this._timer);
    this._timer = null;
    this.pose = "none";
  }

  /* 탭으로 직접 멈췄을 때 — 아직 엎인 채여도 바로 다시 시작하지 않는다 */
  markStopped() {
    this.active = false;
    this.startedAt = 0;
    this.upSince = 0;
    this.downSince = 0;
    this.blockUntilRelease = this.pose === "down";
    this._sync();
  }

  _absorbMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (a && typeof a.z === "number" && Number.isFinite(a.z)) {
      this.last.gz = a.z;
      this.last.t = Date.now();
      if (this.perm === "unknown") { this.perm = "granted"; this._sync(); }
    }
  }

  _absorbOrient(e) {
    if (typeof e.beta === "number" && Number.isFinite(e.beta)) {
      this.last.beta = e.beta;
      if (!this.last.t) this.last.t = Date.now();
      if (this.perm === "unknown") { this.perm = "granted"; this._sync(); }
    }
  }

  evaluate() {
    const now = Date.now();
    const j = judgePose({ beta: this.last.beta, gz: this.last.gz }, { zUp: this.zUp });
    this.zUp = j.zUp;
    this.pose = this.hasSignal ? j.pose : "none";
    if (this.pose === "none") j.pose = "none";

    try { this.onSample?.(this); } catch {}

    if (this.active) {
      // 들지 않았는데 센서 신호가 잠깐 끊긴 것(none)은 정지 사유가 아니다 — 오탐으로 녹음이 끊기면 안 된다
      if (j.pose === "down" || j.pose === "none") { this.upSince = 0; }
      else if (!this.upSince) this.upSince = now;
      if (this.upSince && now - this.upSince >= FLIP_RELEASE_MS) {
        this.active = false;
        this.startedAt = 0;
        this.upSince = 0;
        this.blockUntilRelease = false;
        this._sync();
        try { this.onStop?.("up"); } catch {}
        return;
      }
      this._sync();
      return;
    }

    if (j.pose === "down") {
      if (this.blockUntilRelease || !this.armed) { this.downSince = 0; this._sync(); return; }
      if (!this.downSince) this.downSince = now;
      if (!this.starting && now - this.downSince >= FLIP_HOLD_MS) {
        this.starting = true;
        Promise.resolve()
          .then(() => this.onStart?.())
          .then((ok) => {
            this.starting = false;
            if (ok === false) {
              // 마이크가 막혔거나 데모/로그인 전 — 들었다 다시 엎기 전에는 재시도하지 않는다
              this.blockUntilRelease = true;
              this.downSince = 0;
            } else {
              this.active = true;
              this.startedAt = Date.now();
              this.downSince = 0;
            }
            this._sync();
          })
          .catch(() => { this.starting = false; this.blockUntilRelease = true; this.downSince = 0; this._sync(); });
      }
    } else {
      this.downSince = 0;
      if (j.pose === "up" || j.pose === "tilt") this.blockUntilRelease = false;
    }
    this._sync();
  }

  /* 탭으로 시작한 녹음을 감시 대상으로 편입(들면 자동 저장) */
  adopt() {
    this.active = true;
    this.startedAt = Date.now();
    this.blockUntilRelease = false;
    this.downSince = 0;
    this.upSince = 0;
    this._sync();
  }

  _sync() {
    let s;
    if (!this.supported) s = "unsupported";
    else if (this.active) s = "active";
    else if (this.perm === "denied") s = "denied";
    else if (!this.armed && !this.probe) s = "off";
    else if (!this.listening) s = "need-tap";
    else if (this.perm === "unknown") s = "need-tap";
    // 허용받았는데도 이벤트가 안 들어오는 경우(워치독) — 저전력 모드·설정 토글 등
    else if (!this.hasSignal && Date.now() - (this.listenAt || 0) > 2600) s = "nosignal";
    else s = "ready";
    if (s !== this.state) {
      this.state = s;
      try { this.onState?.(s, this); } catch {}
    }
  }

  /* 사람이 읽는 현재 상태 */
  get label() {
    switch (this.state) {
      case "active": return "녹음 중";
      case "ready": return "대기 중 · 폰을 엎으면 시작";
      case "need-tap": return "센서 권한 필요 · 한 번 탭";
      case "denied": return "센서 권한 차단됨";
      case "nosignal": return "센서 신호 없음";
      case "unsupported": return "센서 미지원";
      default: return "꺼짐";
    }
  }

  get poseLabel() {
    return { down: "엎임(화면 아래)", up: "위(화면 위)", tilt: "들고 있음", none: "신호 없음" }[this.pose] || "—";
  }
}
