# Hemory 개인용 (my-hemory)

내 구글 드라이브에만 저장되는 **개인 녹음 · 전사 · 검색** PWA.
Hemory(hemory.com)의 핵심 흐름 — 녹음 → 자동 전사(타임스탬프·화자) → 유형별 요약 → 문장 탭 재생 → 전체 검색 → 근거 기반 질문 — 을 개인용으로 옮긴 것입니다.

## 이 저장소에 없는 것

- **녹음 파일, 전사문, 요약, API 키: 0건.** 저장소에는 앱 코드만 있습니다.
- 데이터는 전부 사용자의 Google Drive `Hemory-개인녹음/` 폴더에만 저장됩니다.

## 구조

```
index.html  app.css  manifest.webmanifest  sw.js
js/         config.js drive.js store.js search.js qa.js record.js util.js app.js
icons/      iOS 홈 화면 아이콘(180/192/512/maskable)
demo/       가상 데모 데이터 (실사용 데이터 아님)
pipeline/   맥 전사·요약·365일 정리 스크립트
docs/       설정·아이폰·맥 안내
```

## 쓰는 법

1. 폰 Safari에서 https://tessios.github.io/my-hemory/ 열기 → 공유 → **홈 화면에 추가**
2. 최초 1회 Google OAuth Client ID 입력 (`docs/setup-oauth.md`)
3. 녹음하거나 아이폰 음성 메모를 드라이브 `Hemory-개인녹음/_inbox`에 저장
4. 맥이 전사·요약해 같은 폴더에 JSON을 만들면 앱에서 검색·재생

자세한 내용: [docs/iphone.md](docs/iphone.md) · [docs/mac-pipeline.md](docs/mac-pipeline.md) · [docs/hemory-analysis.md](docs/hemory-analysis.md)
