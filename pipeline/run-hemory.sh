#!/bin/zsh
# Hemory 개인용 — 맥에서 전사 파이프라인 + 365일 정리 실행
# launchd/cron 에서 호출합니다. 로그: ~/Library/Logs/hemory-pipeline.log
set -euo pipefail
HEMORY_DIR="${HEMORY_DIR:-$HOME/hemory-pipeline}"
CONFIG="${HEMORY_CONFIG:-$HOME/.config/hemory/config.json}"
LOG="$HOME/Library/Logs/hemory-pipeline.log"
mkdir -p "$(dirname "$LOG")"

# Gemini API 키를 쓰는 경우: ~/.config/hemory/env 에 export GEMINI_API_KEY=... 로 두세요.
[ -f "$HOME/.config/hemory/env" ] && source "$HOME/.config/hemory/env"

# macOS 프레임워크 파이썬은 루트 인증서가 없어 Google API 호출이 SSL 오류가 납니다 → venv의 certifi 사용
if [ -x "$HOME/hemory-pipeline/.venv/bin/python" ]; then
  export SSL_CERT_FILE="$("$HOME/hemory-pipeline/.venv/bin/python" -c 'import certifi;print(certifi.where())' 2>/dev/null || true)"
fi

cd "$HEMORY_DIR"
if [ -x "$HEMORY_DIR/.venv/bin/python" ]; then PY="$HEMORY_DIR/.venv/bin/python"; else PY="$(command -v python3)"; fi

echo "\n===== $(date '+%Y-%m-%d %H:%M:%S') pipeline =====" >> "$LOG"
"$PY" hemory_pipeline.py --once --config "$CONFIG" >> "$LOG" 2>&1 || echo "pipeline 실패" >> "$LOG"

echo "===== $(date '+%Y-%m-%d %H:%M:%S') prune =====" >> "$LOG"
"$PY" hemory_prune.py --purge --config "$CONFIG" >> "$LOG" 2>&1 || echo "prune 실패" >> "$LOG"
