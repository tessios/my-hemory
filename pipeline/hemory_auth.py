#!/usr/bin/env python3
"""
Hemory 개인용 — 맥에서 구글 드라이브 접근을 위한 1회 인증
======================================================

Google Cloud Console 에서 **OAuth 클라이언트 ID → 데스크톱 앱** 을 만들고 JSON 을 내려받은 뒤:

    python3 hemory_auth.py --client-secret ~/Downloads/client_secret_xxx.json

브라우저가 열리면 korea.yoonchan.kim@gmail.com 계정으로 동의하면
`~/.config/hemory/token.json` 이 만들어지고, 그 뒤로는 자동 갱신됩니다.

프롬프트만 있는 환경(원격 SSH 등)에서는:
    python3 hemory_auth.py --client-secret ... --manual
    → 표시되는 주소를 브라우저에서 열고, 리디렉션된 주소의 code=... 값을 붙여넣기
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

SCOPE = "https://www.googleapis.com/auth/drive"
STATE_DIR = Path.home() / ".config" / "hemory"
PORT = 8765
REDIRECT = f"http://localhost:{PORT}/"


def exchange(code: str, cid: str, secret: str, redirect: str) -> dict:
    data = urllib.parse.urlencode({
        "code": code, "client_id": cid, "client_secret": secret,
        "redirect_uri": redirect, "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def auth_url(cid: str, redirect: str) -> str:
    q = urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code",
        "scope": SCOPE, "access_type": "offline", "prompt": "consent",
        "include_granted_scopes": "true",
    })
    return "https://accounts.google.com/o/oauth2/v2/auth?" + q


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-secret", required=True, help="내려받은 client_secret_*.json 경로")
    ap.add_argument("--manual", action="store_true", help="브라우저 자동 열기/로컬 서버 없이 코드 붙여넣기")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()

    cs = json.loads(Path(os.path.expanduser(args.client_secret)).read_text(encoding="utf-8"))
    inst = cs.get("installed") or cs.get("web") or cs
    cid, secret = inst["client_id"], inst.get("client_secret")
    if not secret:
        sys.exit("client_secret 이 없는 클라이언트입니다. '데스크톱 앱' 유형으로 다시 만들어 주세요.")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # 데스크톱 앱 클라이언트는 http://localhost 임의 포트가 허용됩니다.
    target = Path(os.path.expanduser(args.client_secret))
    (STATE_DIR / "client_secret.json").write_text(json.dumps(cs, indent=2), encoding="utf-8")

    redirect = f"http://localhost:{args.port}/"
    url = auth_url(cid, redirect)
    print("\n아래 주소를 브라우저에서 열고 동의해 주세요:\n\n" + url + "\n")

    code = None
    if args.manual:
        pasted = input("리디렉션된 주소 전체(또는 code=...)를 붙여넣고 Enter: ").strip()
        if "code=" in pasted:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(pasted).query or pasted.split("?", 1)[-1])
            code = (qs.get("code") or [""])[0]
        else:
            code = pasted
    else:
        holder = {}

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                holder["code"] = (qs.get("code") or [""])[0]
                holder["error"] = (qs.get("error") or [""])[0]
                body = ("<h2>Hemory 인증 완료</h2><p>이 창을 닫고 터미널로 돌아가세요.</p>"
                        if holder["code"] else f"<h2>인증 실패</h2><p>{holder['error']}</p>")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *a):  # 조용히
                pass

        httpd = socketserver.TCPServer(("127.0.0.1", args.port), H)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            webbrowser.open(url)
        except Exception:
            pass
        print(f"브라우저에서 동의하면 자동으로 이어집니다 (최대 5분 대기, 포트 {args.port}).")
        for _ in range(300):
            if holder.get("code") or holder.get("error"):
                break
            time.sleep(1)
        httpd.shutdown()
        code = holder.get("code")
        if holder.get("error"):
            sys.exit(f"인증 거부/오류: {holder['error']}")

    if not code:
        sys.exit("코드를 받지 못했습니다. --manual 로 다시 시도해 주세요.")

    tok = exchange(code, cid, secret, redirect)
    if "refresh_token" not in tok:
        sys.exit("refresh_token 이 오지 않았습니다. Google 계정 → 보안 → 타사 액세스에서 기존 동의를 제거한 뒤 다시 실행해 주세요.")
    tok["expires_at"] = time.time() + int(tok.get("expires_in", 3500)) - 60
    tok["client_id"] = cid
    out = STATE_DIR / "token.json"
    out.write_text(json.dumps(tok, indent=2), encoding="utf-8")
    os.chmod(out, 0o600)
    print(f"\n저장 완료: {out}")
    print("이제 `python3 hemory_pipeline.py --once --backend drive` 로 실행할 수 있습니다.")


if __name__ == "__main__":
    main()
