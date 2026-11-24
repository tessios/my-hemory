# 최초 1회 설정 — Google OAuth Client ID (5분)

앱은 **정적 페이지만** 배포되고, 로그인은 사용자 본인 구글 계정으로 브라우저에서 직접 합니다.
서버도, 우리 쪽 데이터베이스도 없습니다. 그래서 앱이 내 드라이브를 읽으려면 **내가 만든 OAuth Client ID** 하나가 필요합니다.

> Client ID는 브라우저에 노출되는 공개 값입니다(비밀번호 아님). 비밀 값은 Client **Secret** 인데, 이 방식에서는 쓰지 않습니다.

## 순서

1. <https://console.cloud.google.com/> 접속 → 상단 프로젝트 선택 → **새 프로젝트**
   - 이름: `hemory-personal` → 만들기
2. 왼쪽 메뉴 **API 및 서비스 → 라이브러리** → `Google Drive API` 검색 → **사용 설정**
3. **API 및 서비스 → OAuth 동의 화면**
   - User Type: **외부** → 만들기
   - 앱 이름 `Hemory`, 사용자 지원 이메일·개발자 연락처: `korea.yoonchan.kim@gmail.com`
   - 범위(Scopes): **추가하지 않아도 됩니다**(앱이 요청 시 지정). 굳이 추가하려면 `.../auth/drive`
   - 테스트 사용자: **korea.yoonchan.kim@gmail.com 추가** (이걸 빠뜨리면 로그인 시 `403 access_denied`)
   - 게시 상태는 **테스트** 그대로 두면 됩니다(본인 계정만 쓰므로 검증 불필요)
4. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 이름: `my-hemory-web`
   - **승인된 JavaScript 출처**: `https://tessios.github.io`
   - **승인된 리디렉션 URI**: `https://tessios.github.io/my-hemory/`
     (iOS 홈 화면 앱에서 팝업이 막힐 때 쓰는 리다이렉트 방식에 필요합니다)
   - 만들기 → 표시되는 `....apps.googleusercontent.com` 값 복사
5. 폰에서 <https://tessios.github.io/my-hemory/> 열기
   - 첫 화면 **"처음 설정 · Client ID 입력"** → 붙여넣기 → 저장
   - **Google 계정으로 시작** → `korea.yoonchan.kim@gmail.com` 선택 → 권한 허용
6. 앱이 드라이브의 `Hemory-개인녹음/` 폴더를 찾고, 없으면 새로 만듭니다(이미 만들어 둔 폴더가 있습니다).

## 맥(전사 파이프라인)용 인증은 따로 1회

맥은 브라우저가 아니므로 **데스크톱 앱** 유형 클라이언트가 필요합니다.

1. 같은 화면에서 **OAuth 클라이언트 ID → 데스크톱 앱** 이름 `hemory-mac` → 만들기 → **JSON 다운로드**
2. 맥에서:
   ```bash
   python3 hemory_auth.py --client-secret ~/Downloads/client_secret_xxx.json
   ```
   브라우저가 열리면 같은 계정으로 동의 → `~/.config/hemory/token.json` 생성(자동 갱신).
3. 두 클라이언트(웹/데스크톱)는 같은 GCP 프로젝트·같은 동의 화면을 공유하므로 테스트 사용자 추가는 한 번만 하면 됩니다.

## 선택 — Gemini API 키

AI Q&A와 폰에서의 즉시 전사에 씁니다.

1. <https://aistudio.google.com/apikey> → **Create API key** (같은 프로젝트 선택)
2. 앱 **설정 → AI → Gemini API 키**에 붙여넣기 (이 기기에만 저장, 드라이브·저장소에 올라가지 않음)
3. 맥에서도 쓰려면 `~/.config/hemory/env` 에 `export GEMINI_API_KEY=...` (파일 권한 600)

키가 없어도 앱은 **검색·재생·타임라인**이 모두 동작하고, 전사·요약은 맥(whisper)이 담당합니다.

## 자주 나는 오류

| 증상 | 원인 / 해결 |
|---|---|
| `403 access_denied` | 동의 화면 **테스트 사용자**에 내 계정이 없음 → 추가 |
| `idpiframe_initialization_failed` | 서드파티 쿠키·팝업 차단. Safari 설정에서 교차 사이트 추적 방지 해제 또는 리다이렉트 방식으로 자동 전환됨 |
| 로그인 후 바로 풀림 | 토큰은 1시간. 앱이 조용히 갱신하며, 실패하면 설정 → Google 연결을 한 번 눌러 주세요 |
| `Drive 403 insufficientPermissions` | 다른 계정으로 로그인했거나 Drive API가 꺼져 있음 |
| 드라이브에 폴더가 안 보임 | 앱이 만든 폴더는 `Hemory-개인녹음` 이름으로 내 드라이브 최상위에 생성됩니다. 새로고침 |
| iOS 홈 화면 앱에서 로그인 창이 안 뜸 | 팝업 차단. 앱이 자동으로 리다이렉트 로그인으로 넘어갑니다(승인된 리디렉션 URI 등록 필요) |
