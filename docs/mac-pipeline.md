# 맥(Sophias-iMac) 전사 파이프라인 설치·예약

> **2026-11-24 이 맥에 설치·가동 완료.** 상태: `~/hemory-pipeline` 설치, Python 3.14.7 가상환경에 faster-whisper 1.2.1, 백엔드 **drive**(드라이브 데스크톱 앱이 없어서 API 경로), `~/.config/hemory/token.json` 발급, launchd `com.hemory.pipeline` 30분 간격 등록·실행 확인. 아래는 같은 일을 다시 하거나 다른 맥에 설치할 때의 절차입니다.

## 이 맥에서 실측한 값 (2026-11-24)

| 항목 | 값 |
|---|---|
| 설치 경로 | `/Users/sophiakim/hemory-pipeline` (소스 사본 `~/hemory-src`) |
| 백엔드 | `drive` — `~/Library/CloudStorage` 에 iCloudDrive만 있고 Google Drive 데스크톱 없음 |
| 자격 | `~/.config/hemory/client_secret.json`(데스크톱 앱 클라이언트) · `token.json`(refresh token, mode 600) |
| 실행 | `launchctl list \| grep hemory` → `com.hemory.pipeline`, 30분(1800초)·로그인 시 1회 |
| 로그 | `~/Library/Logs/hemory-pipeline.log` |
| whisper | `medium`, CPU int8 — 13초 음성을 약 11초에 전사(모델 최초 다운로드 약 2.5분) |
| 요약 | **미설정(Gemini 키 없음)** — 전사만 저장되고 `요약 실패(...)` 로그가 남습니다 |

### 이 맥에서 반드시 필요한 두 가지 (설치본에 반영됨)

1. **SSL 인증서** — macOS 프레임워크 파이썬은 루트 인증서가 없어 Google API 호출이 `CERTIFICATE_VERIFY_FAILED` 로 죽습니다.
   → `requirements.txt` 에 `certifi` 를 넣고, `run-hemory.sh` 가 `SSL_CERT_FILE` 을 certifi 번들로 지정합니다.
2. **PyAV 19 호환** — `av.open(metadata_errors=...)` 인자가 PyAV 19 에서 사라져 faster-whisper 1.2.x 전사가 `TypeError` 로 실패합니다.
   → `hemory_pipeline.py` 의 `_patch_pyav_compat()` 가 그 인자만 걸러 호출합니다.

녹음 파일은 드라이브에만 있고, 맥이 주기적으로 훑어 **전사 → 화자 추정 → 유형 분류 → 요약** 후 JSON을 만들어 앱이 읽습니다.
맥이 꺼져 있으면 전사만 밀리고(녹음은 그대로 드라이브에 있음), 켜지면 다음 실행에 처리됩니다.

## 0. 준비물

| 항목 | 확인 |
|---|---|
| Python 3.10+ | `python3 -V` (맥에 3.14 설치되어 있음) |
| 드라이브 접근 | 아래 A(데스크톱 동기화) 또는 B(API) 중 하나 |
| 전사 엔진 | **A: faster-whisper**(무료·로컬) 또는 **B: Gemini API 키** |
| 요약 | Gemini API 키(권장) 또는 Gemini CLI 로그인 |

## 1. 파일 설치

가장 빠른 길(권장) — 저장소에서 스크립트를 받아 설치합니다:

```bash
cd ~/Downloads
git clone --depth 1 https://github.com/tessios/my-hemory.git my-hemory-src
zsh my-hemory-src/pipeline/install-mac.sh          # ~/hemory-pipeline 에 설치
# Gemini 전사만 쓸 경우: HEMORY_SKIP_WHISPER=1 zsh my-hemory-src/pipeline/install-mac.sh
```

수동 설치:

```bash
mkdir -p ~/hemory-pipeline && cd ~/hemory-pipeline
# 저장소에서 pipeline 폴더 복사
#   git clone --depth 1 https://github.com/tessios/my-hemory.git /tmp/my-hemory
#   cp /tmp/my-hemory/pipeline/* ~/hemory-pipeline/
python3 -m venv .venv && source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt          # faster-whisper (약 5분, 모델은 첫 실행 때 자동 다운로드)
```

`faster-whisper` 를 쓰지 않고 Gemini로만 전사하려면 `requirements.txt` 설치를 건너뛰어도 됩니다(표준 라이브러리만 사용).

## 2. 드라이브 연결 — 둘 중 하나

### A. 구글 드라이브 데스크톱 앱 (가장 단순, 권장)
1. **Google 드라이브** 앱 설치 → 평소 쓰는 본인 계정 로그인 → **내 드라이브 스트리밍** 선택
2. 동기화 위치: `~/Library/CloudStorage/GoogleDrive-<내계정>/내 드라이브/Hemory-개인녹음`
3. 설정에서 `backend: "local"`, `local_root` 를 위 경로로 지정

### B. Drive API (앱 설치 없이)
```bash
python3 hemory_auth.py --client-secret ~/Downloads/client_secret_hemory-mac.json
```
→ `~/.config/hemory/token.json` 생성. 설정에서 `backend: "drive"`.

## 3. 설정 파일

```bash
mkdir -p ~/.config/hemory
cp hemory_config.example.json ~/.config/hemory/config.json
chmod 600 ~/.config/hemory/config.json
# Gemini 키를 쓸 경우
printf 'export GEMINI_API_KEY="AIza..."\n' > ~/.config/hemory/env && chmod 600 ~/.config/hemory/env
```

`config.json` 에서 손볼 값:

| 키 | 의미 | 권장 |
|---|---|---|
| `backend` | `local` / `drive` | 2번에서 고른 것 |
| `local_root` | A 방식 경로 | 위 경로 |
| `asr.engine` | `auto` / `whisper` / `gemini` | `auto`(whisper 있으면 whisper) |
| `asr.whisper_model` | `small` `medium` `large-v3-turbo` | Apple Silicon: `medium`(정확도·속도 균형), 느리면 `small` |
| `asr.vad` | `{ "enabled": true, "min_silence_ms": 600, "threshold": 0.5 }` — 침묵 구간을 건너뛰고 말한 구간만 전사 | 기본값 그대로(켜기) 권장 |
| `diarization.method` | `auto` / `pyannote` / `gemini` / `none` | `auto` |
| `summary.model` | Gemini 모델 | `gemini-3.6-flash` |
| `retention_days` | 보관 일수 | `365` |

### 침묵 구간 자동 건너뛰기 (VAD, 기본 켜짐)

`faster-whisper` 로 전사할 때 `vad_filter=True` 가 기본으로 걸려, 말이 없는 구간은 전사에서 빼고 실제 말한 구간만 처리합니다. 기본값은 `min_silence_ms: 600`(0.6초 넘게 조용하면 그 구간을 건너뜀)입니다.

- 더 긴 침묵만 건너뛰고 싶으면 `min_silence_ms` 를 올립니다(예: `1000`).
- 조용한 회의실에서 말끝이 잘리면 `threshold` 를 낮춥니다(0.5 → 0.35).
- 전사를 그대로(무음 포함) 받고 싶으면 `"enabled": false`.
- 이 설정은 `asr.engine: gemini` 에는 적용되지 않습니다(제미나이는 파일 전체를 보고 전사).

## 4. 첫 실행

```bash
cd ~/hemory-pipeline && source .venv/bin/activate
python3 hemory_pipeline.py --once --dry-run     # 무엇을 처리할지 미리 확인
python3 hemory_pipeline.py --once               # 실제 처리
python3 hemory_prune.py --dry-run               # 365일 지난 파일 미리 확인
```

로직만 검사하고 싶으면(모델·키 없이): `python3 hemory_pipeline.py --self-test`

처리 결과는 `Hemory-개인녹음/YYYY-MM/*.json` 로 떨어지고, 앱에서 동기화하면 바로 보입니다.

## 5. 예약 실행 (launchd, 30분마다)

```bash
cp com.hemory.pipeline.plist ~/Library/LaunchAgents/
# __USER__ → sophiakim, __HEMORY_DIR__ → /Users/sophiakim/hemory-pipeline 로 바꾼 뒤
launchctl load ~/Library/LaunchAgents/com.hemory.pipeline.plist
launchctl list | grep hemory
tail -f ~/Library/Logs/hemory-pipeline.log
```

- `run-hemory.sh` 가 **전사 + 365일 정리**를 한 번에 수행합니다.
- 맥이 잠자기 상태면 깨어날 때 실행됩니다(놓친 주기는 1회).
- 정지: `launchctl unload ~/Library/LaunchAgents/com.hemory.pipeline.plist`

### 대안: Pickle 예약 작업 + 맥 러너
이미 `tessios/pickle-mac-control` 러너가 있다면, Pickle 예약 작업이
`gh api --method POST repos/tessios/pickle-mac-control/actions/workflows/mac-commander.yml/dispatches -f ref=main -f 'inputs[command]=zsh ~/hemory-pipeline/run-hemory.sh'`
를 실행하도록 걸 수 있습니다. 단, 러너가 다른 작업(무신사 응모 등)과 겹치면 대기하므로 launchd 쪽이 더 확실합니다.

## 6. 성능·비용 참고 (Apple Silicon iMac)

| 모드 | 1시간 회의 처리 시간(대략) | 비용 |
|---|---|---|
| whisper `small` (int8, CPU) | 6~12분 | 0원 |
| whisper `medium` (int8, CPU) | 15~30분 | 0원 |
| Gemini `gemini-3.6-flash` (Files API) | 1~3분 | 오디오 분당 과금(무료 한도 내면 0원) |

`diarization: gemini` 는 전사문 텍스트만 보내므로 추가 비용이 작습니다. `pyannote` 는 정확하지만 HuggingFace 토큰과 모델 다운로드(~1GB)가 필요합니다.

## 7. 장애 대응

| 로그 | 원인 / 조치 |
|---|---|
| `faster-whisper 가 설치되어 있지 않습니다` | `pip install faster-whisper` 또는 `asr.engine: gemini` |
| `Gemini API 키가 없습니다` | `~/.config/hemory/env` 확인(launchd는 셸 설정을 읽지 않음) |
| `긴 오디오 전사에는 Gemini API 키가 필요합니다` | 18MB 초과 → Files API 경로. 키 필요 |
| `Drive 403` | 토큰 만료/권한 → `python3 hemory_auth.py` 재실행 |
| `폴더가 없습니다` | 드라이브 동기화 경로 오타, 또는 드라이브 앱이 로그아웃됨 |
| 전사는 되는데 요약이 빔 | 요약 단계 실패(키/쿼터). 전사 JSON은 저장되므로 나중에 `--force` 로 재처리 |

## 8. 365일 자동 정리 정책

- `hemory_prune.py`: 만든 지 365일 지난 오디오+JSON 을 `_trash/YYYY-MM/` 로 이동(삭제 아님).
- `--purge`: `_trash` 에서 30일 지난 것만 실제 삭제. `run-hemory.sh` 는 이 옵션으로 돌므로 **총 395일 뒤 완전 삭제**.
- 드라이브 백엔드에서는 실제 삭제 대신 드라이브 **휴지통**으로 보냅니다(30일 후 자동 삭제).
- 기록: `Hemory-개인녹음/_state/prune-log.jsonl`, 실행 로그: `~/Library/Logs/hemory-pipeline.log`

## 드라이브 백엔드에서의 365일 정리 (실측)

`backend: drive` 이면 365일 지난 오디오+JSON 을 `_trash/` 폴더로 옮기는 대신 **드라이브 휴지통으로 보냅니다**(휴지통은 30일 뒤 Google이 자동 삭제). 실측 로그:

```
[12:29:35] 정리 시작 · 백엔드=drive · 보관 365일 · dry_run=False
[12:29:38]  드라이브 휴지통은 30일 뒤 자동 삭제됩니다(추가 조치 없음)
[12:29:38] 이동 0건 · 삭제 0건 · 보존 0건
```

(로컬 백엔드는 `_trash/YYYY-MM/` 로 이동 → 30일 뒤 `--purge` 로 실제 삭제. `_trash` 폴더는 drive 백엔드에서 쓰지 않습니다.)

## 검증 기록 (2026-11-24)

- 한국어 TTS 샘플(13초)을 `_inbox` 에 올려 전 구간 확인: `inbox 오디오 1개` → whisper 전사 4문장 → `Hemory-개인녹음/2026-11/*.json` 저장(`schema: hemory.transcript.v1`) → 오디오를 월 폴더로 이동 → 앱에서 동기화해 표시·재생 확인.
- 정리 경로: `retention_days` 를 잠시 0으로 두고 실행 → 월 폴더의 오디오+JSON 이 정리되고(드라이브 백엔드는 휴지통) 원래 365로 복구.
- launchd 경로: `launchctl start com.hemory.pipeline` → 전사·정리 둘 다 exit 0, 로그 정상.

## 상주 감시(준실시간) 모드 — v1.6 (2026-11-26)

30분 원샷(`--once`)은 매번 파이썬을 새로 띄우고 whisper 모델을 다시 메모리에 올린다(3~10초).
v1.6 은 **데몬 하나가 계속 살아 있으면서 15초마다 `_inbox` 를 훑는** `--watch` 모드를 쓴다.

```zsh
# 직접 실행(디버그)
cd ~/hemory-pipeline
./.venv/bin/python hemory_pipeline.py --watch --interval 15 --config ~/.config/hemory/config.json

# launchd 상주 데몬으로 등록(KeepAlive)
cp pipeline/com.hemory.pipeline.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.hemory.pipeline 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hemory.pipeline.plist
launchctl print gui/$(id -u)/com.hemory.pipeline | grep -E "state|pid"
```

- `run-hemory.sh` 는 `HEMORY_WATCH=1` 이면 `--watch` 로, 아니면 예전처럼 `--once` + prune 으로 돈다.
- 상주 모드에서 365일 정리(prune)는 **감시 프로세스가 1시간마다** 스스로 실행한다(`PRUNE_INTERVAL_SEC`).
- **새 파일 대기 시간**: 예전 `GROWING_SKIP_SEC=90`(업로드 중인 파일을 집지 않으려고)이 90초 지연을 만들었다.
  지금은 10초 + "크기가 지난 폴링과 같아야 처리" 확인으로 바꿔, 올라온 뒤 보통 **15~25초**에 전사가 시작된다.
- **`_inbox` 고착 정리**: 월 폴더에 같은 이름 JSON 이 이미 있으면 그 오디오는 `_inbox` 에 영구히 남던 버그를 고쳤다.
  월 폴더에 같은 이름 오디오가 없으면 월 폴더로 옮기고, 이미 있으면 중복 사본이므로 `_trash` 로 보낸다(휴지통 30일 복원).
- **다시 요약**: Gemini 503/429 로 요약만 실패해 제목이 "11월 26일 기록" 으로 남은 기록은
  `--resummarize --since YYYY-MM-DD [--diarize]` 로 전사문은 그대로 두고 제목·요약만 다시 만든다.
  상주 감시는 **30분마다 오늘 기록 중 요약이 빈 것을 최대 5건** 스스로 다시 채운다(무료 티어 429/503 대비, 모델 재시도에
  간격을 두고 **한 바퀴 더** 시도).
- **상태 확인**: `~/.config/hemory/status.json` 에 `watch_pid`·`watch_cycles`·`watch_heartbeat_at`(10분마다)·`watch_processed_total` 이 남는다.
- **락**: 회차마다 `~/.config/hemory/pipeline.lock` 을 잡았다 놓으므로, 수동 `--once` 나 다른 실행과 겹쳐도 한쪽만 처리한다. 3시간 넘은 락은 죽은 실행으로 보고 지운다.
- **맥 잠자기**: 잠들면 프로세스도 멈춘다(깨어나면 launchd 가 다시 띄운다 — `KeepAlive`). 잠자기를 막으려면
  `sudo pmset -a sleep 0` 또는 `caffeinate -s` 를 함께 둔다. (디스플레이는 꺼져도 됨 — `displaysleep 0` 은 취향)
- **전사 속도가 진짜 병목**: medium/CPU(int8) 실측으로 실시간의 0.5~1배다. 1,100초 회의는 여전히 10~17분 걸린다.
  체감 준실시간은 `small`/`base` 모델이나 `whisper_device: "mps"`(Apple Silicon, 로그가 2배 이상 빠르다고 권고)로 바꿔야 한다.
