/* 앱을 떠났다가 돌아왔을 때 — 마이크·센서를 '다시 묻지 않고' 이어 쓰기 위한 판단
   ─────────────────────────────────────────────────────────────
   iOS 홈 화면 앱은 앱 전환(백그라운드) 때 오디오 캡처를 끊습니다.
   · 트랙은 보통 muted 가 되고(ended 아님), 돌아오면 unmute 가 옵니다 → 그대로 재사용.
   · 끝내 unmute 가 오지 않거나 ended 면 새로 열어야 합니다.
   · 센서 권한은 페이지 단위라 백그라운드 전환으로 사라지지 않습니다.
     돌아왔을 때 이벤트만 멈춰 있으면 리스너를 다시 걸고, 그래도 안 오면 탭에서 재개합니다.
   이 파일은 DOM 없이 판단만 하므로 단위 테스트로 확인합니다. */

/* unmute 를 기다려 주는 시간 — 짧으면 멀쩡한 트랙을 버리게 되고, 길면 복귀가 늦어 보인다 */
export const UNMUTE_WAIT_MS = 1200;
/* 복귀 뒤 이 시간 동안 센서 이벤트가 없으면 '신호 없음'이 아니라 '탭해서 재개'로 안내 */
export const SENSOR_QUIET_MS = 1000;

/* 마이크: 지금 상태에서 무엇을 할지 */
export function micResumePlan(status = {}, { permission = "unknown" } = {}) {
  const { held, live, readyState, muted, state } = status || {};
  if (!held) return { action: "none", reason: "no-lease" };           // 이번 실행에서 아직 연 적 없음 → 다음 터치
  if (live) return { action: "keep", reason: "live" };                // 살아 있음 → 아무 것도 하지 않는다
  if (state === "denied") return { action: "gesture", reason: "denied" };
  if (readyState === "ended") {
    return permission === "prompt"
      ? { action: "gesture", reason: "permission-prompt" }            // 새 권한 창을 띄우지 않는다
      : { action: "reopen", reason: "ended" };
  }
  if (muted || state === "interrupted") return { action: "wait-unmute", reason: "muted" };
  if (state === "lost") return { action: "reopen", reason: "lost" };
  return { action: "keep", reason: "unknown" };
}

/* unmute 를 기다린 뒤에도 muted 면 새로 연다(권한이 prompt 면 열지 않고 제스처를 기다린다) */
export function afterUnmuteWait({ live, muted, held }, { permission = "unknown", ended = false } = {}) {
  if (live && !muted) return { action: "keep", reason: "unmuted" };
  if (!held) return { action: "none", reason: "no-lease" };
  if (ended) return { action: "reopen", reason: "ended" };
  if (permission === "prompt") return { action: "gesture", reason: "permission-prompt" };
  return { action: "reopen", reason: "still-muted" };
}

/* 센서: 복귀 뒤 감시를 어떻게 되살릴지
   · 이미 허용받았으면 권한을 다시 묻지 않는다(리스너만 다시 건다).
   · 이번 로드에서 허용 전(unknown)이면 탭이 필요하다(제스처 안에서 requestPermission). */
export function sensorResumePlan({ perm, listening, armed, probe, hasSignal, quietMs = 0 } = {}, { visible = true } = {}) {
  if (!visible) return "none";
  if (perm === "denied" || perm === "unsupported") return "none";
  if (!armed && !probe) return "none";
  if (!listening) return perm === "unknown" ? "need-tap" : "restart";
  if (!hasSignal && quietMs >= SENSOR_QUIET_MS) return "restart";
  return "none";
}

/* 복귀 직후 센서가 조용할 때 화면에 무엇을 띄울지 */
export function sensorQuietLabel({ perm, listening, hasSignal, quietMs = 0, armed } = {}) {
  if (perm === "denied") return "센서 권한 차단됨";
  if (!hasSignal && quietMs >= SENSOR_QUIET_MS && (armed || listening)) return "탭해서 센서 재개";
  return "";
}

/* ── v1.7: 사용자 터치 없이 마이크를 다시 잡아도 되는가 ─────────────────
   iOS 는 getUserMedia 에 제스처를 요구하지 않는다(WebKit). 다만 처음 권한을 묻는
   순간에는 사용자 동작이 있는 편이 좋고, 이미 허용된 사이트면 프롬프트 없이 열린다.
   그래서 '권한이 granted' 이거나 '이 대여(이번 실행)에서 이미 열어 둔 트랙'일 때만
   조용히 시도하고, 아직 prompt 인데 한 번도 허용한 적이 없으면 첫 탭을 기다린다.
   (Claude 검토 반영 — micAllowed 플래그는 안내 문구 선택에만 쓰고 판정에는 쓰지 않는다) */
export function autoMicPlan({ permission = "unknown", held = false, live = false, everAllowed = false, busy = false } = {}) {
  if (busy) return { action: "skip", reason: "busy" };
  if (live) return { action: "keep", reason: "live" };                 // 살아 있음 → 아무 것도 하지 않는다
  if (permission === "denied") return { action: "denied", reason: "permission-denied" };
  if (permission === "granted") return { action: held ? "reopen" : "open", reason: "permission-granted" };
  if (held) return { action: "reopen", reason: "lease-lost" };          // 이번 실행에서 허용받은 대여가 끊김
  if (permission === "prompt") return { action: "gesture", reason: "permission-prompt" };
  if (everAllowed) return { action: "open", reason: "previously-allowed" }; // unknown(미지원) + 예전 허용
  return { action: "gesture", reason: "never-allowed" };
}

/* 마이크가 열리지 않았을 때 화면에 남길 한 줄 — 진짜 막힌 경우에만 안내한다 */
export function micGuide({ reason = "", permission = "unknown", everAllowed = false } = {}) {
  const r = String(reason || "");
  if (r === "NotReadableError" || r === "TrackStartError" || r === "AbortError") return "다른 앱이 마이크를 쓰고 있습니다";
  if (permission === "denied" || r === "denied" || r === "permission-denied") return "설정 > 앱 > 마이크에서 허용해 주세요";
  if (everAllowed) return "화면을 한 번 탭하면 마이크를 연결합니다";
  return "";
}

/* ── v1.7: 대기 중 마이크 레벨 표시의 상태 판정 ────────────────────────
   핵심은 '0 을 무음으로 오탐하지 않는 것'이다. AudioContext 가 잠들어 있으면
   analyser 는 0 만 돌려주는데, 그것을 '무음'이라고 적으면 마이크가 죽은 것처럼 보인다.
     none       대여 없음            → '마이크 없음(탭)'
     lost       트랙 종료            → '끊김'
     interrupted 트랙 muted           → '중단됨'
     waiting    컨텍스트가 running 이 아님 → '측정 대기 · 탭하면 확인' (0 을 믿지 않는다)
     nosignal   1초 넘게 정확히 0     → '신호 없음' (그래프·트랙 이상)
     silent     바닥 잡음 수준이 3초  → '무음' (조용한 방, 정상)
     live       그 외                → 레벨 막대 */
export function meterVerdict({ hasStream = false, ended = false, muted = false, ctxRunning = false, rms = null, zeroMs = 0, quietMs = 0, floor = 0 } = {}) {
  if (!hasStream) return "none";
  if (ended) return "lost";
  if (muted) return "interrupted";
  if (!ctxRunning || rms == null) return "waiting";
  if (rms === 0 && zeroMs >= 1000) return "nosignal";
  if (rms > 0 && rms <= Math.max(0.004, floor * 2) && quietMs >= 3000) return "silent";
  return "live";
}

/* ── v1.7: 업로드 재전송 큐 ───────────────────────────────────────────
   오프라인·토큰 만료로 드라이브 업로드가 실패한 녹음은 IndexedDB 에 남는다.
   그 큐를 언제 다시 보낼지: 온라인·화면이 보일 때, 실패할수록 간격을 늘린다(최대 10분). */
export const QUEUE_BASE_MS = 30000;
export const QUEUE_MAX_MS = 10 * 60 * 1000;

export function queueBackoff(fails = 0, base = QUEUE_BASE_MS, max = QUEUE_MAX_MS) {
  const n = Math.max(0, Math.min(8, Math.round(Number(fails) || 0)));
  return Math.min(max, base * 2 ** n);
}

export function queueDue({ now = 0, lastTry = 0, fails = 0, count = 0, online = true, visible = true } = {}) {
  if (count <= 0) return false;
  if (!online || !visible) return false;
  return now - (lastTry || 0) >= queueBackoff(fails);
}
