# 최초 1회 설정 — Google OAuth Client ID (5분)

> **2026-11-24 발급·적용 완료 (아래 "지금 설정된 것" 참고).** 웹 클라이언트 ID는 `js/config.js`에 기본값으로 들어 있어 폰에서 첫 화면 **Google 계정으로 시작**만 누르면 됩니다.

## 지금 설정된 것 (2026-11-24)

| 항목 | 값 |
|---|---|
| Google Cloud 프로젝트 | `personal-mode-app` (ID `gifted-loader-515703-m7`, 소유 계정 korea.yoonchan.kim@gmail.com) |
| **사용자 유형** | **개인(Personal)** — 만든 계정 본인만 인증 가능, 앱 검증 불필요, **테스트 모드의 7일 refresh token 만료 없음**, "확인하지 않은 앱" 경고도 뜨지 않음 |
| 사용 설정 API | Google Drive API |
| 데이터 액세스 범위 | `https://www.googleapis.com/auth/drive` (제한 범위) |
| 웹 클라이언트 `Hemory Web (personal)` | `746533653611-s8keromh27u55lptk5l05guldvhiq7lo.apps.googleusercontent.com`<br>출처 `https://tessios.github.io` · 리디렉션 `https://tessios.github.io/my-hemory/` |
| 데스크톱 클라이언트 `Hemory Mac (personal)` | `746533653611-l58cq094ncl1lefis87r4ahhmjuegetk.apps.googleusercontent.com` — 시크릿/토큰은 맥 `~/.config/hemory/` 에만 있음(저장소에 없음) |

- 개인(Personal) 모드는 **프로젝트를 만들 때 한 번만** 고를 수 있고 되돍릴 수 없습니다. 새로 만들 때는 <https://console.cloud.google.com/auth/overview/personal> 에서 **웹 애플리케이션**으로 시작한 뒤, 같은 프로젝트의 **클라이언트 → 클라이언트 만들기**에서 **데스크톱 앱**을 하나 더 추가하면 됩니다.
- 처음 시도했던 `my-hemory` 프로젝트(외부 + 테스트 모드)의 클라이언트는 쓰지 않습니다. 테스트 모드는 토큰이 **7일마다 만료**되어 30분 자동 전사에 부적합합니다. (정리하려면 그 프로젝트를 지우면 됩니다.)
- 다른 계정으로는 인증되지 않습니다(`client_user_mismatch`). 계정을 바꾸려면 개인 모드 프로젝트를 새로 만들어야 합니다.

## 순서 (새로 만들 때)

앱은 **정적 페이지만** 배포되고, 로그인은 사용자 본인 구글 계정으로 브라우저에서 직접 합니다.
서버도, 우리 쪽 데이터베이스도 없습니다. 그래서 앱이 내 드라이브를 읽으려면 **내가 만든 OAuth Client ID** 하나가 필요합니다.

> Client ID는 브라우저에 노출되는 공개 값입니다(비밀번호 아님). 비밀 값은 Client **Secret** 인데, 웹 앱은 쓰지 않고 맥 파이프라인만 로컬에 보관합니다.

1. <https://console.cloud.google.com/auth/overview/personal> — **개인 모드 온보딩**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 자바스크립트 출처: `https://tessios.github.io` / 리디렉션 URI: `https://tessios.github.io/my-hemory/`
   - 계속 → 클라이언트 ID가 나옵니다(프로젝트 `personal-mode-app` 자동 생성).
2. 왼쪽 **API 및 서비스 → 라이브러리 → Google Drive API → 사용 설정** (새 프로젝트라 꺼져 있습니다).
3. **인증 플랫폼 → 데이터 액세스 → 범위 추가** 에 `https://www.googleapis.com/auth/drive` (테스트 모드일 때만 필요, 개인 모드는 선택).
4. **클라이언트 → 클라이언트 만들기 → 데스크톱 앱** 이름 `Hemory Mac (personal)` → 만들기 → **JSON 다운로드**.
5. `js/config.js` 의 `clientId` 에 웹 클라이언트 ID를 넣고 배포(이미 들어 있음).

## 맥(전사 파이프라인)용 인증은 따로 1회

맥은 브라우저가 아니므로 **데스크톱 앱** 유형 클라이언트가 필요합니다.

1. 4번에서 받은 `client_secret_*.json` 을 맥으로 옮깁니다(공개 저장소·메신저에 올리지 않기).
2. 맥에서:
   ```bash
   cd ~/hemory-pipeline && ./.venv/bin/python hemory_auth.py --client-secret ~/Downloads/client_secret_xxx.json
   ```
   브라우저가 열리면 같은 계정으로 동의 → `~/.config/hemory/token.json` 생성(자동 갱신).
3. 토큰을 받은 뒤 `config.json` 의 `backend` 가 `drive` 인지 확인.

## 선택 — Gemini API 키

요약·화자 추정(제미나이 추정)·AI에게 묻기·폰 즉시 전사는 **Gemini API 키**가 있어야 합니다.
없으면 전사(whisper)와 검색·재생은 그대로 동작하고, 요약 칸만 비어 있습니다(로그에 `요약 실패(...) → 전사만 저장`).

- 키 발급: <https://aistudio.google.com/apikey> (**personal-mode-app** 프로젝트를 고르면 같은 프로젝트에서 발급).
- 맥: `printf 'export GEMINI_API_KEY="AIza..."\n' > ~/.config/hemory/env && chmod 600 ~/.config/hemory/env`
- 폰: 앱 **설정 → Gemini 키** 에 붙여넣기(그 폰에만 저장).

## 자주 나는 오류

| 화면/로그 | 뜻 / 조치 |
|---|---|
| `403 access_denied` (테스트 모드) | 테스트 사용자 목록에 본인 계정이 없음 → 추가 |
| `client_user_mismatch` | 개인 모드 앱은 만든 계정만 인증 가능 → 다른 계정으로는 못 씀 |
| `idpiframe_initialization_failed` | 서드파티 쿠키 차단 → `js/drive.js` 의 리다이렉트 폴백 사용 |
| `redirect_uri_mismatch` | 리디렉션 URI에 `https://tessios.github.io/my-hemory/` 가 없음(끝 슬래시 포함) |
| 앱에서 `Drive 403` | 범위 미허용/토큰 만료 → 다시 **Google 계정으로 시작** |
| 맥 로그 `Drive 403` | `~/.config/hemory/token.json` 재발급(위 2번) |
