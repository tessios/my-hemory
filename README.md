# Hemory 개인용 (my-hemory)

**https://tessios.github.io/my-hemory/** — 내 구글 드라이브에만 저장되는 개인 녹음·전사·검색 PWA.
아이폰 **Safari → 홈 화면에 추가** 로 앱처럼 쓰고, Apple Developer 계정은 필요 없습니다.

Hemory(hemory.com)의 핵심 흐름 — 녹음 → 자동 전사(타임스탬프·화자) → 유형별 요약 → 문장 탭 재생 → 전체 검색 → 근거 기반 질문 — 을 개인용으로 옮긴 것입니다.

## 지금 상태 (2026-11-24)

- **OAuth 발급 완료** — 개인 모드 프로젝트 `personal-mode-app` 의 웹/데스크톱 클라이언트. 웹 클라이언트 ID는 `js/config.js` 에 기본값으로 들어 있어 폰에서 바로 "Google 계정으로 시작" 가능. 자세히는 [docs/setup-oauth.md](docs/setup-oauth.md).
- **로그인 유지(v1.3.2)** — 로그인한 사람을 토큰과 별도로 저장해 1시간 만료·앱 재실행에도 첫 화면으로 돌아가지 않습니다. 만료 시 무음 자동 갱신(아이폰 홈 화면 앱은 리다이렉트, 데스크톱은 팝업), 실패 시 앱 안 '다시 연결' 막대. [docs/iphone.md#5-로그인-유지-v132](docs/iphone.md).
- **맥 파이프라인 가동** — 집 맥(Sophias-iMac)에 설치되어 launchd 로 30분마다 드라이브를 훑어 전사·저장합니다. 상태·실측값·장애 대응은 [docs/mac-pipeline.md](docs/mac-pipeline.md).
- **남은 것: Gemini API 키** — 요약·화자 추정·AI 질문에 필요. 없으면 전사·검색·재생만 동작하고 요약 칸이 비어 있습니다.

## 이 저장소에 없는 것

- **녹음 파일·전사문·요약·API 키·계정 정보: 0건.** 저장소에는 앱 코드와 가상 데모 데이터만 있습니다.
- 실제 데이터는 전부 사용자의 Google Drive `Hemory-개인녹음/` 폴더에만 저장됩니다.
- 서버가 없습니다. 브라우저가 Google OAuth로 본인 드라이브에 직접 접근합니다.

## 구조

```
index.html  app.css  manifest.webmanifest  sw.js
js/         config.js drive.js store.js search.js qa.js record.js util.js app.js
icons/      iOS 홈 화면 아이콘(180/192/512/maskable)
demo/       가상 데모 데이터 (실사용 데이터 아님)
pipeline/   맥 전사·요약·365일 정리 (Python, 표준 라이브러리 + faster-whisper)
docs/       Hemory 분석 · OAuth 설정 · 아이폰 사용법 · 맥 파이프라인
```

## 3단계로 쓰기

1. **앱 설치** — 폰 Safari에서 위 주소 → 공유 → 홈 화면에 추가
2. **최초 1회 설정** — Google Cloud에서 OAuth Client ID 발급 후 앱 설정에 붙여넣기 → [docs/setup-oauth.md](docs/setup-oauth.md)
3. **녹음·검색** — 짧은 메모는 앱 녹음 버튼, 긴 회의는 아이폰 음성 메모 → 드라이브 `_inbox` → 맥 자동 전사 → [docs/iphone.md](docs/iphone.md) · [docs/mac-pipeline.md](docs/mac-pipeline.md)

## 기능

| | |
|---|---|
| 타임라인 | 날짜·시간별 카드, 회의/업무/식사/일상/학습 필터, 한 줄 요약 |
| 전사 | 문장별 타임스탬프·화자, 문장 탭 → 그 지점부터 재생(±15초, 0.8~1.5배속) |
| 녹음 | 녹음 중 **화면 꺼짐 방지**(Wake Lock) · **침묵 구간 자동 건너뛰기**(VAD, 기본 ON) |
| 예약 녹음 | 월~일 요일·시간 스케줄, 시간이 되면 자동 시작·자동 저장 (앱이 열린 동안) |
| 뒤집어 녹음 | 폰을 엎으면 1.5초 뒤 자동 시작 + 검은 절전 화면, 들면 자동 저장 |
| 유실 방지 | 화면이 가려지거나 앱을 나가면 그때까지의 녹음을 즉시 저장(기기 큐 → 드라이브) |
| 요약 | 회의=안건·결정·액션아이템, 일상=가벼운 메모. 유형 자동 분류 |
| 검색 | 전 문장·요약·결정·액션 통합 검색, 띄어쓰기 무시, 하이라이트 |
| AI 질문 | 검색된 근거만으로 답변 + 근거 카드(Gemini 키, 선택) |
| 보관 | 1년 지난 녹음 자동 정리(휴지통 경유 395일) |
| 오프라인 | 서비스 워커로 앱 껍데기 캐시, 전사 JSON은 기기에 캐시 |

설계 판단과 Hemory 기능 대응표는 [docs/hemory-analysis.md](docs/hemory-analysis.md).
