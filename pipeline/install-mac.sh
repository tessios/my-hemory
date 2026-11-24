#!/bin/zsh
# Hemory 개인용 — 맥 설치 도우미 (파일 복사 + 가상환경 + 설정 파일)
#   zsh install-mac.sh [설치경로]      기본: ~/hemory-pipeline
#   HEMORY_SKIP_WHISPER=1 zsh install-mac.sh   (Gemini 로만 전사할 때)
set -euo pipefail
DEST="${1:-$HOME/hemory-pipeline}"
REPO="https://github.com/tessios/my-hemory.git"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "▸ 저장소 내려받는 중…"
git clone --depth 1 "$REPO" "$TMP/repo" >/dev/null

mkdir -p "$DEST"
cp "$TMP/repo/pipeline/"*.py "$DEST/"
cp "$TMP/repo/pipeline/"*.plist "$TMP/repo/pipeline/"*.json "$TMP/repo/pipeline/requirements.txt" "$DEST/"
cp "$TMP/repo/pipeline/run-hemory.sh" "$DEST/"
chmod +x "$DEST/run-hemory.sh"
echo "▸ 파일 설치: $DEST"

if [ ! -d "$DEST/.venv" ]; then
  echo "▸ 파이썬 가상환경 만드는 중…"
  python3 -m venv "$DEST/.venv"
fi
"$DEST/.venv/bin/pip" install -q -U pip

if [ "${HEMORY_SKIP_WHISPER:-0}" != "1" ]; then
  echo "▸ faster-whisper 설치 (약 200MB, 3~10분)…"
  "$DEST/.venv/bin/pip" install -q -r "$DEST/requirements.txt" || \
    echo "  ! faster-whisper 설치 실패 — Gemini 전사로만 쓰려면 설정에서 asr.engine = \"gemini\""
fi

mkdir -p "$HOME/.config/hemory"
if [ ! -f "$HOME/.config/hemory/config.json" ]; then
  cp "$DEST/hemory_config.example.json" "$HOME/.config/hemory/config.json"
  chmod 600 "$HOME/.config/hemory/config.json"
  echo "▸ 설정 파일 생성: ~/.config/hemory/config.json (backend·local_root 확인)"
fi

cat <<'EOS'

다음 순서
1) 드라이브 연결
   A) Google 드라이브 데스크톱 앱 동기화 폴더를 쓴다 → config.json 의 backend=local, local_root 확인
   B) API 로 쓴다 → python3 ~/hemory-pipeline/hemory_auth.py --client-secret <client_secret.json>
                config.json 의 backend=drive
2) Gemini 키(요약·긴 오디오 전사)
   printf 'export GEMINI_API_KEY="AIza..."\n' > ~/.config/hemory/env && chmod 600 ~/.config/hemory/env
3) 시험 실행
   cd ~/hemory-pipeline && ./.venv/bin/python hemory_pipeline.py --once --dry-run
   cd ~/hemory-pipeline && ./.venv/bin/python hemory_pipeline.py --once
4) 30분마다 자동 실행
   sed -e "s/__USER__/$USER/g" -e "s#__HEMORY_DIR__#$HOME/hemory-pipeline#g" \
       ~/hemory-pipeline/com.hemory.pipeline.plist > ~/Library/LaunchAgents/com.hemory.pipeline.plist
   launchctl load ~/Library/LaunchAgents/com.hemory.pipeline.plist
EOS
