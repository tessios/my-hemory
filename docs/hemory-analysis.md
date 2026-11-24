# Hemory 분석 → 개인용 버전 매핑

기준: 2026-11-24 `hemory.com` 공개 페이지에서 확인한 내용과 이 저장소의 구현.

## Hemory가 하는 일 (공개 페이지 기준)

| 영역 | Hemory |
|---|---|
| 입력 | 상시 듣기(Manual / Schedule 모드, 예: 평일 9–18시), VAD로 말이 있는 구간만 과금 |
| 타임라인 | 시간축에 MEETING · MEAL · WORK 같은 유형 태그, 참석자 이름, 한 줄 요약 |
| 검색 | 축적된 기억을 자연어로 검색 (`search_memory`) |
| 에이전트 연결 | MCP 서버로 Claude Code · Codex · Gemini · Cursor · VS Code 등에 연결 |
| 생성 | "이번 달 업무 보고 덱", "매일 22시 저널", 인터뷰 기반 PRD 등 문서 생성 |
| 개인정보 | 클라우드에 오디오를 남기지 않음(처리 후 파기), 원본 오디오는 기기 내에만, 자체 호스팅 준비 중 |
| 가격 | 무료 체험 10시간(1회), 월 20시간 · 60시간 플랜(유료) |

## 개인용 버전에서 옮긴 것 / 옮기지 않은 것

| Hemory 기능 | 개인용 구현 | 상태 |
|---|---|---|
| 녹음 → 전사 | ① 폰 브라우저 녹음(MediaRecorder, 짧은 메모) ② 아이폰 음성 메모 → 드라이브 업로드 → 맥 자동 전사 | 구현 |
| 타임스탬프 전사 | 문장별 `start`/`end` 초 단위, 문장 탭 시 해당 지점부터 재생 | 구현 |
| 화자 구분 | faster-whisper + (pyannote 또는 Gemini 추정) — 확실치 않으면 `화자`로 표기 | 구현(추정 표시) |
| AI 정제·요약 | 유형별 요약 JSON: 회의=안건·결정·액션아이템, 일상·식사=가벼운 bullets | 구현 |
| 활동 유형 자동 분류 | `meeting / work / meal / daily / study / etc` 자동 판정 + 수동 지정 | 구현 |
| 문장 탭 → 오디오 재생 | 드라이브 오디오 스트리밍 + 문장 동기화 하이라이트, ±15초·배속 | 구현 |
| 전체 전사 검색 | 전 문장·요약·결정·액션을 로컬 인덱스로 즉시 검색(띄어쓰기 무시) | 구현 |
| AI Q&A | 검색된 근거 문장만으로 Gemini가 답변 + 근거 카드 | 구현(키 설정 시) |
| MCP로 에이전트 연결 | **미구현**. 대신 드라이브에 표준 JSON이 쌓여 어떤 도구로도 읽을 수 있음 | 향후 |
| 상시 듣기 | **미구현(의도적)**. 24시간 마이크는 배터리·프라이버시·맥 상시가동 문제 | 제외 |
| 클라우드에 오디오 미보관 | **더 강한 쪽으로 변경**: 오디오·전사 모두 사용자 본인 드라이브에만 저장, 서비스 서버 없음 | 구현 |
| 요금 | 0원. Gemini 무료/유료 키, 맥 로컬 whisper 사용 | — |

## 저장 구조 (구글 드라이브 `Hemory-개인녹음/`)

```
Hemory-개인녹음/                  id 1RJDGCj2oVnhcL9uHzgrURzGczdJYgw2f
├── _inbox/                       아이폰 음성메모·단축어가 올리는 곳 (맥이 처리 후 비움)
├── 2026-11/                      월별 폴더 (맥이 자동 생성)
│   ├── 20261124-0930_meeting_a1b2c3.m4a
│   └── 20261124-0930_meeting_a1b2c3.json   ← 앱이 읽는 전사·요약
├── _trash/2020-11/               365일 지난 파일 (맥이 이동)
└── _state/                       처리·정리 로그(로컬 백엔드일 때)
```

파일 이름 규칙 `YYYYMMDD-HHMM_<유형>_<임의6자>.<확장자>` — 이름만으로 시각·유형을 복원합니다.

## 전사 JSON (`hemory.transcript.v1`)

```json
{
  "schema": "hemory.transcript.v1",
  "id": "20261124-0930_meeting_a1b2c3",
  "title": "2.0 출시 준비 회의",
  "type": "meeting",
  "started_at": "2026-11-24T09:30:00+09:00",
  "duration_sec": 1930,
  "source": "iphone",
  "status": "done",
  "summary": {
    "one_line": "…", "bullets": ["…"], "agenda": ["…"], "decisions": ["…"],
    "actions": [{"owner": "개발", "task": "…", "due": "8월 14일"}], "keywords": ["…"]
  },
  "speakers": ["PM", "개발"],
  "segments": [{"i": 0, "start": 2.4, "end": 9.1, "speaker": "PM", "text": "…"}],
  "audio": {"file_name": "20261124-0930_meeting_a1b2c3.m4a", "size": 1234567},
  "engine": {"asr": "faster-whisper/medium", "diarization": "gemini-estimated", "summary": "gemini-2.5-flash"}
}
```

이 스키마만 지키면 전사 주체(맥 whisper, 맥 Gemini, 폰 Gemini)가 달라도 앱은 동일하게 읽습니다.
