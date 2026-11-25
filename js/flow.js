/* v1.5.1 — 녹음 흐름 판단(순수 함수)
   ─────────────────────────────────────────────────────────────
   앱은 "지금 무엇을 해야 하는가"를 이 파일의 판단에 맡기고, 실제 동작만 한다.
   DOM 이 없어 단위 테스트로 확인한다(tests/flow.test.mjs).

   · flipBootPlan: 앱을 열었을 때 뒤집어 녹음(센서)을 어떤 상태로 되살릴지.
     저장된 설정(faceDown)이 켜져 있는데도 앱을 새로 열 때 armed 를 복원하지 않아
     타임라인에서 엎어도 녹음이 시작되지 않던 v1.5.0 버그의 재발 방지선이다.
   · resumePlan: 녹음 도중 앱을 나갔다(백그라운드) 돌아왔을 때 이어서 녹음할지,
     한 번 탭을 받아야 하는지, 그냥 끝낼지. */

/* 앱을 나갔다 와도 이 시간 안이면 같은 세션으로 이어서 녹음한다 */
export const RESUME_GAP_MS = 15 * 60 * 1000;

/* 앱 시작·복귀 시 뒤집어 녹음 준비 상태
   ask: "none" | "silent"(제스처 없이 한 번 시도 — 이미 허용된 사이트면 프롬프트 없이 granted)
                     | "tap"(첫 사용자 탭에서 requestPermission) */
export function flipBootPlan({ pref = false, supported = true, granted = false, perm = "unknown", micLive = false } = {}) {
  const warmMic = !!pref && !micLive;
  if (!pref) return { arm: false, listen: false, ask: "none", warmMic: false };
  if (!supported) return { arm: false, listen: false, ask: "none", warmMic };
  if (granted) return { arm: true, listen: true, ask: "none", warmMic };
  if (perm === "denied") return { arm: true, listen: false, ask: "none", warmMic };
  return { arm: true, listen: false, ask: "silent", warmMic };
}

/* 복귀 뒤 이어서 녹음
   action: "auto"(사용자 터치 없이 다시 시작) | "gesture"(한 번 탭) | "expire"(너무 오래 지남) | "none" | "wait" */
export function resumePlan({
  armed = false, gapMs = 0, micLive = false, micMuted = false, perm = "unknown",
  visible = true, busy = false, maxGapMs = RESUME_GAP_MS,
} = {}) {
  if (!armed) return { action: "none", reason: "not-armed" };
  if (!visible) return { action: "wait", reason: "hidden" };
  if (busy) return { action: "none", reason: "busy" };
  if (gapMs > maxGapMs) return { action: "expire", reason: "too-long" };
  // muted 트랙으로 시작하면 무음만 담긴다 → unmute 를 기다렸다가 시작한다(호출한 쪽이 resumeMicAfterBackground 로 대기)
  if (micLive && !micMuted) return { action: "auto", reason: "mic-live" };
  if (micLive && micMuted) return { action: "auto", reason: "wait-unmute" };
  if (perm === "granted") return { action: "auto", reason: "permission-granted" };
  return { action: "gesture", reason: perm === "prompt" ? "permission-prompt" : "mic-lost" };
}

/* 이어서 녹음을 시작하려면 마이크를 새로 열어야 하는가 */
export function needsMicOpen({ micLive = false } = {}) {
  return !micLive;
}

/* 녹음 세션의 이름 — 이어붙인 구간은 같은 제목 아래에 쌓인다 */
export function chainTitle(kind, at = new Date()) {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  if (kind === "face") return `뒤집어 녹음 ${hh}:${mm}`;
  if (kind === "auto") return `예약 녹음 ${hh}:${mm}`;
  if (kind === "resume") return `이어서 녹음 ${hh}:${mm}`;
  return `새 녹음 ${hh}:${mm}`;
}
