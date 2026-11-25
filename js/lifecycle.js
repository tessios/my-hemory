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
