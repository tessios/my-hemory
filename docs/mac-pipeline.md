# 맥(Sophias-iMac) 전사 파이프라인 설치·예약

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
1. **Google 드라이브** 앱 설치 → `korea.yoonchan.kim@gmail.com` 로그인 → **내 드라이브 스트리밍** 선택
2. 동기화 위치: `~/Library/CloudStorage/GoogleDrive-korea.yoonchan.kim@gmail.com/내 드라이브/Hemory-개인녹음`
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
| `diarization.method` | `auto` / `pyannote` / `gemini` / `none` | `auto` |
| `summary.model` | Gemini 모델 | `gemini-2.5-flash` |
| `retention_days` | 보관 일수 | `365` |

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
| Gemini `gemini-2.5-flash` (Files API) | 1~3분 | 오디오 분당 과금(무료 한도 내면 0원) |

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
