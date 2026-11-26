#!/usr/bin/env python3
"""
Hemory 개인용 — 맥 전사·요약 파이프라인
=====================================

구글 드라이브 `Hemory-개인녹음/` 폴더를 훑어
  · `_inbox` 에 새로 올라온 오디오(아이폰 음성메모·웹 녹음)
  · 아직 전사 JSON 이 없는 오디오
를 찾아  전사 → 화자 구분 → 유형 분류 → 요약  을 수행하고
같은 이름의 `.json` 을 월 폴더(`YYYY-MM/`)에 만든 뒤 오디오도 그 폴더로 옮깁니다.

지원 엔진
  ASR       : faster-whisper (로컬, 무료)  또는  gemini (Files API)
  화자 구분 : pyannote(BLE)  →  gemini(추정)  →  없음
  요약      : gemini (API 키 또는 `gemini` CLI)

사용 예
  python3 hemory_pipeline.py --once                 # 한 번만 처리
  python3 hemory_pipeline.py --once --dry-run       # 무엇을 할지만 출력
  python3 hemory_pipeline.py --once --engine whisper --limit 3
  python3 hemory_pipeline.py --once --backend local --root ~/Hemory-개인녹음
  python3 hemory_pipeline.py --watch                # 상주 감시(기본 15초 폴링, 모델 1회 로드)
  python3 hemory_pipeline.py --resummarize --since 2026-11-26   # 제목·요약이 빈 기록 다시 요약

설정 파일: ~/.config/hemory/config.json (없으면 pipeline/hemory_config.example.json 참고)
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HOME = Path.home()
CONFIG_PATH = HOME / ".config" / "hemory" / "config.json"
STATE_DIR = HOME / ".config" / "hemory"
AUDIO_EXT = {".m4a", ".mp3", ".wav", ".aac", ".caf", ".ogg", ".opus", ".webm", ".mp4", ".flac"}
STATUS_PATH = STATE_DIR / "status.json"
LOCK_PATH = STATE_DIR / "pipeline.lock"
LOCK_STALE_SEC = 3 * 3600          # 이보다 오래된 락은 죽은 실행으로 본다
GROWING_SKIP_SEC = 10              # 방금 올라온 파일은 이만큼 기다렸다 집는다(업로드 중 잘린 파일 방지)
GROWING_STABLE_SEC = 4            # 상주 감시에서 크기가 이만큼 지켜봐도 같아야 다 올라온 것으로 본다
WATCH_INTERVAL_SEC = 15            # 상주 감시 폴링 간격(초)
WATCH_HEARTBEAT_SEC = 300          # 조용할 때 대기 로그를 남기는 간격(초)
PRUNE_INTERVAL_SEC = 3600          # 상주 감시 중 365일 정리를 다시 도는 간격(초)
RESUMMARIZE_INTERVAL_SEC = 1800    # 상주 감시 중 '요약이 빈 기록'을 다시 채우는 간격(초)
DEADMAN_SEC = 3 * 3600             # 마지막 성공이 이보다 오래되면 경고


class AuthError(RuntimeError):
    """OAuth 토큰이 만료·해제되어 더 이상 진행할 수 없음(재인증 필요)."""


def read_status() -> dict:
    try:
        return json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_status(**patch) -> dict:
    cur = read_status()
    cur.update(patch)
    cur["updated_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        STATUS_PATH.write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(STATUS_PATH, 0o600)
    except Exception:
        pass
    return cur


def notify_mac(message: str, title: str = "Hemory") -> None:
    """맥 알림 센터에 알린다(러너/launchd 환경에서 실패해도 무시)."""
    try:
        msg = message.replace('"', "'")[:180]
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{msg}" with title "{title}"'],
            check=False, timeout=10,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def acquire_lock():
    """동시에 두 번 돌지 않게 락 파일. 성공하면 파일 핸들, 실패하면 None."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        if LOCK_PATH.exists():
            age = time.time() - LOCK_PATH.stat().st_mtime
            stale = age > LOCK_STALE_SEC
            if not stale:
                # 죽은 프로세스가 남긴 락이면 지운다(KeepAlive 재시작 시 3시간 막히는 것을 막는다)
                try:
                    pid = int(LOCK_PATH.read_text().strip() or 0)
                except Exception:
                    pid = 0
                if pid and pid != os.getpid():
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        stale = True
                    except PermissionError:
                        pass
            if stale:
                LOCK_PATH.unlink(missing_ok=True)
                log(f"오래됐거나 죽은 실행의 락 파일 정리({int(age/60)}분)")
            else:
                return None
        fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, str(os.getpid()).encode())
        return fd
    except FileExistsError:
        return None
    except Exception:
        return None


def release_lock(fd) -> None:
    try:
        if fd is not None:
            os.close(fd)
    except Exception:
        pass
    try:
        LOCK_PATH.unlink(missing_ok=True)
    except Exception:
        pass

TYPES = ("meeting", "work", "meal", "daily", "study", "etc")

DEFAULTS = {
    "backend": "local",                     # local | drive
    "root_name": "Hemory-개인녹음",
    "local_root": str(HOME / "Library/CloudStorage/GoogleDrive-my-drive/My Drive/Hemory-개인녹음"),
    "inbox": "_inbox",
    "trash": "_trash",
    "state": "_state",
    "retention_days": 365,
    "asr": {
        "engine": "auto",                   # auto | whisper | gemini
        "whisper_model": "medium",          # tiny/base/small/medium/large-v3/large-v3-turbo
        "whisper_device": "cpu",
        "whisper_compute": "int8",
        "language": "ko",
        # VAD(음성 구간 검지): 침묵 구간을 건너뛰고 실제 말한 구간만 전사한다
        "vad": {"enabled": True, "min_silence_ms": 600, "threshold": 0.5},
    },
    "diarization": {"method": "auto"},      # auto | pyannote | gemini | none
    "summary": {
        "provider": "auto",                 # auto | api | cli | none
        "model": "gemini-3.6-flash",
        "fallback_models": ["gemini-3.6-flash", "gemini-flash-latest"],  # 앞 모델이 404(단종)/503(과부하)이면 차례로 시도
        "api_key_env": "GEMINI_API_KEY",
    },
    "gemini_cli": "gemini",
    "max_minutes": 180,
}


# ─────────────────────────────────────────── 유틸
def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def deep_merge(base: dict, extra: dict) -> dict:
    out = dict(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path: Path | None = None) -> dict:
    p = path or CONFIG_PATH
    cfg = DEFAULTS
    if p.exists():
        cfg = deep_merge(cfg, json.loads(p.read_text(encoding="utf-8")))
    cfg["_path"] = str(p)
    return cfg


def ensure_dirs(cfg: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def slug(text: str, limit: int = 28) -> str:
    t = re.sub(r"[^\w가-힣]+", "-", (text or "").strip()).strip("-")
    return t[:limit] or "memo"


def parse_stamp(name: str) -> dt.datetime | None:
    m = re.match(r"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})", name)
    if not m:
        return None
    try:
        return dt.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]))
    except ValueError:
        return None


def now_local() -> dt.datetime:
    return dt.datetime.now().astimezone()


def iso_local(d: dt.datetime) -> str:
    if d.tzinfo is None:
        d = d.astimezone()
    return d.isoformat(timespec="seconds")


# ─────────────────────────────────────────── 저장소 백엔드
class LocalBackend:
    """구글 드라이브 데스크톱 앱 / rclone 으로 동기화된 로컬 폴더."""

    kind = "local"

    def __init__(self, root: str):
        self.root = Path(os.path.expanduser(root))
        if not self.root.exists():
            raise SystemExit(f"폴더가 없습니다: {self.root}\n"
                             "· Google 드라이브 데스크톱 앱으로 내 드라이브를 동기화했는지 확인하거나\n"
                             "· --backend drive 로 실행하세요.")

    def folder(self, name: str) -> Path:
        p = self.root / name
        p.mkdir(parents=True, exist_ok=True)
        return p

    def month_folder(self, when: dt.datetime) -> Path:
        return self.folder(f"{when:%Y-%m}")

    def list_audio(self, folder: Path) -> list[dict]:
        out = []
        for p in sorted(folder.glob("*")):
            if p.is_file() and p.suffix.lower() in AUDIO_EXT:
                st = p.stat()
                out.append({
                    "name": p.name, "base": p.stem, "path": p,
                    "created": dt.datetime.fromtimestamp(st.st_ctime),
                    "modified": dt.datetime.fromtimestamp(st.st_mtime),
                    "size": st.st_size,
                })
        return out

    def has_json(self, folder: Path, base: str) -> bool:
        return (folder / f"{base}.json").exists()

    def read_bytes(self, item: dict) -> bytes:
        return Path(item["path"]).read_bytes()

    def write_json(self, folder: Path, name: str, data: dict) -> str:
        p = folder / name
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return str(p)

    def move(self, item: dict, dest_folder: Path) -> str:
        src = Path(item["path"])
        dest_folder.mkdir(parents=True, exist_ok=True)
        dest = dest_folder / src.name
        if dest.exists():
            dest = dest_folder / f"{src.stem}-{int(time.time())}{src.suffix}"
        shutil.move(str(src), str(dest))
        item["path"] = dest
        return str(dest)

    def existing_json(self, folder: Path, base: str) -> dict | None:
        p = folder / f"{base}.json"
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None

    def list_json(self, folder: Path) -> list[dict]:
        out = []
        for p in sorted(Path(folder).glob("*.json")):
            if p.is_file():
                out.append({"name": p.name, "base": p.stem, "path": p})
        return out


class DriveBackend:
    """Google Drive REST (OAuth 설치형 클라이언트, hemory_auth.py 로 1회 동의)."""

    kind = "drive"
    API = "https://www.googleapis.com/drive/v3"
    UPLOAD = "https://www.googleapis.com/upload/drive/v3"

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.creds_path = Path(os.path.expanduser(cfg.get("credentials", str(STATE_DIR / "client_secret.json"))))
        self.token_path = Path(os.path.expanduser(cfg.get("token", str(STATE_DIR / "token.json"))))
        if not self.creds_path.exists():
            raise SystemExit(f"OAuth 클라이언트 파일이 없습니다: {self.creds_path}\n"
                             "· `python3 hemory_auth.py --client-secret <client_secret.json>` 로 1회 인증하세요.")
        self.creds = json.loads(self.creds_path.read_text(encoding="utf-8"))
        inst = self.creds.get("installed") or self.creds.get("web") or {}
        self.client_id = inst.get("client_id")
        self.client_secret = inst.get("client_secret")
        self._folder_cache: dict[str, str] = {}
        self._root_id = None
        self._load_token()

    # 인증 -------------------------------------------------
    def _load_token(self):
        self.token = json.loads(self.token_path.read_text(encoding="utf-8")) if self.token_path.exists() else {}
        if not self.token.get("refresh_token"):
            raise SystemExit("토큰이 없습니다. `python3 hemory_auth.py` 를 먼저 실행하세요.")

    def _access_token(self) -> str:
        exp = self.token.get("expires_at", 0)
        if self.token.get("access_token") and exp > time.time() + 60:
            return self.token["access_token"]
        data = urllib.parse.urlencode({
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "refresh_token": self.token["refresh_token"],
            "grant_type": "refresh_token",
        }).encode()
        req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if "invalid_grant" in detail or e.code in (400, 401):
                raise AuthError(
                    "Google 토큰이 만료되었거나 해제되었습니다(invalid_grant). "
                    "맥에서 재인증이 필요합니다: python3 hemory_auth.py --client-secret ~/.config/hemory/client_secret.json"
                ) from e
            raise
        self.token["access_token"] = j["access_token"]
        self.token["expires_at"] = time.time() + int(j.get("expires_in", 3500)) - 60
        self.token_path.write_text(json.dumps(self.token, indent=2), encoding="utf-8")
        return self.token["access_token"]

    def _req(self, method: str, url: str, data: bytes | None = None, headers: dict | None = None) -> dict:
        h = {"Authorization": "Bearer " + self._access_token()}
        h.update(headers or {})
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                body = r.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"Drive {method} {url.split('?')[0]} → {e.code}: {detail}") from e

    # 폴더 -------------------------------------------------
    def _find(self, name: str, parent: str) -> str | None:
        q = f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' and '{parent}' in parents and trashed = false"
        j = self._req("GET", f"{self.API}/files?q={urllib.parse.quote(q)}&fields=files(id,name)&pageSize=5")
        files = j.get("files") or []
        return files[0]["id"] if files else None

    def _find_file(self, name: str, parent: str) -> str | None:
        """같은 이름의 파일(폴더 제외) id. _find 는 폴더 전용이라 파일에는 쓰지 않는다."""
        q = f"name = '{name}' and mimeType != 'application/vnd.google-apps.folder' and trashed = false"
        j = self._req("GET", f"{self.API}/files?q={urllib.parse.quote(q)}&fields=files(id,name,parents)&pageSize=20")
        for f in (j.get("files") or []):
            if parent in (f.get("parents") or []):
                return f["id"]
        return None

    def _mkdir(self, name: str, parent: str) -> str:
        body = json.dumps({"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent]}).encode()
        j = self._req("POST", f"{self.API}/files?fields=id", body,
                      {"Content-Type": "application/json"})
        return j["id"]

    def root(self) -> str:
        if self._root_id:
            return self._root_id
        name = self.cfg["root_name"]
        fid = self._find(name, "root") or self._mkdir(name, "root")
        self._root_id = fid
        return fid

    def folder(self, name: str) -> str:
        if name in self._folder_cache:
            return self._folder_cache[name]
        fid = self._find(name, self.root()) or self._mkdir(name, self.root())
        self._folder_cache[name] = fid
        return fid

    def month_folder(self, when: dt.datetime) -> str:
        return self.folder(f"{when:%Y-%m}")

    # 파일 -------------------------------------------------
    def list_audio(self, folder_id: str) -> list[dict]:
        q = f"'{folder_id}' in parents and trashed = false"
        j = self._req("GET", f"{self.API}/files?q={urllib.parse.quote(q)}"
                             "&fields=files(id,name,size,createdTime,modifiedTime,mimeType)&pageSize=1000")
        out = []
        for f in j.get("files", []):
            name = f["name"]
            base, ext = os.path.splitext(name)
            if ext.lower() not in AUDIO_EXT:
                continue
            out.append({
                "name": name, "base": base, "id": f["id"], "folder_id": folder_id,
                "created": dt.datetime.fromisoformat(f["createdTime"].replace("Z", "+00:00")),
                "modified": dt.datetime.fromisoformat(f["modifiedTime"].replace("Z", "+00:00")),
                "size": int(f.get("size") or 0),
            })
        return out

    def has_json(self, folder_id: str, base: str) -> bool:
        return self._find_file(f"{base}.json", folder_id) is not None

    def read_bytes(self, item: dict) -> bytes:
        h = {"Authorization": "Bearer " + self._access_token()}
        req = urllib.request.Request(f"{self.API}/files/{item['id']}?alt=media", headers=h)
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.read()

    def _upload(self, folder_id: str, name: str, data: bytes, mime: str) -> str:
        boundary = "----hemory" + hashlib.md5(name.encode()).hexdigest()[:12]
        meta = json.dumps({"name": name, "parents": [folder_id]}).encode()
        body = (b"--" + boundary.encode() + b"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta +
                b"\r\n--" + boundary.encode() + b"\r\nContent-Type: " + mime.encode() + b"\r\n\r\n" + data +
                b"\r\n--" + boundary.encode() + b"--")
        j = self._req("POST", f"{self.UPLOAD}/files?uploadType=multipart&fields=id", body,
                      {"Content-Type": f"multipart/related; boundary={boundary}"})
        return j["id"]

    def write_json(self, folder_id: str, name: str, data: dict) -> str:
        blob = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        # 같은 이름이 있으면 내용만 교체
        old = self._find_file(name, folder_id)
        if old:
            self._req("PATCH", f"{self.UPLOAD}/files/{old}?uploadType=media", blob,
                      {"Content-Type": "application/json; charset=UTF-8"})
            return old
        return self._upload(folder_id, name, blob, "application/json")

    def move(self, item: dict, dest_folder_id: str) -> str:
        self._req("PATCH", f"{self.API}/files/{item['id']}?addParents={dest_folder_id}&removeParents={item['folder_id']}",
                  b"{}", {"Content-Type": "application/json"})
        item["folder_id"] = dest_folder_id
        return item["id"]

    def existing_json(self, folder_id: str, base: str) -> dict | None:
        fid = self._find_file(f"{base}.json", folder_id)
        if not fid:
            return None
        h = {"Authorization": "Bearer " + self._access_token()}
        req = urllib.request.Request(f"{self.API}/files/{fid}?alt=media", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception:
            return None

    def list_json(self, folder_id: str) -> list[dict]:
        q = f"'{folder_id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'"
        j = self._req("GET", f"{self.API}/files?q={urllib.parse.quote(q)}"
                             "&fields=files(id,name,modifiedTime)&pageSize=1000")
        out = []
        for f in j.get("files", []):
            name = f["name"]
            if not name.lower().endswith(".json"):
                continue
            out.append({"name": name, "base": name[:-5], "id": f["id"], "folder_id": folder_id})
        return out


def make_backend(cfg: dict):
    if cfg["backend"] == "drive":
        return DriveBackend(cfg)
    return LocalBackend(cfg["local_root"])


def folder_of(be, name: str):
    return be.folder(name)


# ─────────────────────────────────────────── 전사 엔진
_WHISPER: dict = {}


def _whisper_model(cfg: dict):
    """faster-whisper 모델을 한 번만 로드해 재사용한다(상주 감시에서 재로드 비용 제거)."""
    _patch_pyav_compat()
    from faster_whisper import WhisperModel  # type: ignore

    a = cfg["asr"]
    global _WHISPER
    key = (a["whisper_model"], a["whisper_device"], a["whisper_compute"])
    if _WHISPER.get("key") != key:
        log(f"  · whisper 모델 로드: {a['whisper_model']}")
        _WHISPER["model"] = WhisperModel(a["whisper_model"], device=a["whisper_device"], compute_type=a["whisper_compute"])
        _WHISPER["key"] = key
    return _WHISPER["model"]


def _patch_pyav_compat() -> None:
    """PyAV 19 부터 av.open(metadata_errors=...) 인자가 없어졌는데
    faster-whisper 1.2.x 가 그 인자를 넘겨 전사가 TypeError 로 죽습니다.
    넘겨받은 인자만 조용히 걸러 호환시킵니다(다른 동작은 그대로)."""
    try:
        import av  # type: ignore
    except Exception:
        return
    if getattr(av.open, "_hemory_compat", False):
        return
    _orig_open = av.open

    def _open_compat(*args, **kwargs):
        kwargs.pop("metadata_errors", None)
        return _orig_open(*args, **kwargs)

    _open_compat._hemory_compat = True  # type: ignore[attr-defined]
    av.open = _open_compat  # type: ignore[assignment]


def transcribe_whisper(path_or_bytes, cfg: dict, name: str = "audio") -> dict:
    _patch_pyav_compat()
    try:
        model = _whisper_model(cfg)
    except ImportError:
        raise RuntimeError("faster-whisper 가 설치되어 있지 않습니다: pip install faster-whisper")

    a = cfg["asr"]
    vad_cfg = a.get("vad") or {}
    vad_on = bool(vad_cfg.get("enabled", True))
    vad_params = None
    if vad_on:
        vad_params = {"min_silence_duration_ms": int(vad_cfg.get("min_silence_ms", 600))}
        if vad_cfg.get("threshold") is not None:
            vad_params["threshold"] = float(vad_cfg["threshold"])
    if isinstance(path_or_bytes, (bytes, bytearray)):
        tmp = STATE_DIR / "tmp" / name
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(path_or_bytes)
        src = str(tmp)
    else:
        src = str(path_or_bytes)

    segments, info = model.transcribe(
        src,
        language=a.get("language") or None,
        vad_filter=vad_on,
        vad_parameters=vad_params,
        beam_size=5,
        condition_on_previous_text=False,
    )
    segs = []
    for i, s in enumerate(segments):
        text = (s.text or "").strip()
        if not text:
            continue
        segs.append({"i": len(segs), "start": round(float(s.start), 2), "end": round(float(s.end), 2),
                     "speaker": "", "text": text})
    return {"segments": segs, "language": getattr(info, "language", None) or a.get("language") or "ko",
            "engine": {"asr": f"faster-whisper/{a['whisper_model']}", "device": a["whisper_device"],
                       "vad": vad_on}}


def gemini_generate(parts: list, cfg: dict, json_mode: bool = False, model: str | None = None) -> str:
    key = os.environ.get(cfg["summary"]["api_key_env"]) or cfg["summary"].get("api_key")
    mdl = model or cfg["summary"]["model"]
    if key:
        body = {"contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"temperature": 0.15, "maxOutputTokens": 8192}}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        # 단종(404)·과부하(503/429) 모델을 만나면 다음 모델로 넘어가고,
        # 그래도 안 되면 잠시 쉬었다(무료 티어 분당 한도) 한 바퀴 더 돈다.
        fallbacks = [m for m in cfg["summary"].get("fallback_models", []) if m and m != mdl]
        last: Exception | None = None
        for rnd in range(2):
            for cand in [mdl] + fallbacks:
                req = urllib.request.Request(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{cand}:generateContent?key={urllib.parse.quote(key)}",
                    data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
                try:
                    with urllib.request.urlopen(req, timeout=600) as r:
                        j = json.loads(r.read())
                    return "".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"]).strip()
                except urllib.error.HTTPError as e:
                    last = e
                    if e.code not in (404, 429, 500, 502, 503, 504):
                        raise
                    log(f"  · 모델 {cand} 실패({e.code}) → 다음 모델로 재시도")
                    # 429(분당/일 한도)는 오래 갈 수 있어 짧게만 쉬고, 503(과부하)은 조금 더 쉰다
                    time.sleep(3 if e.code == 429 else 2 + 2 * rnd)
                except (TimeoutError, urllib.error.URLError) as e:
                    last = e
                    log(f"  · 모델 {cand} 시간 초과/연결 실패 → 다음 모델로 재시도")
            code = getattr(last, "code", None)
            # 503·500 은 잠깐 뒤 풀리는 경우가 많아 한 바퀴 더, 429 는 대기 비용만 커져
            #   여기서 멈추고 '요약 없는 기록'으로 두었다가 상주 감시(30분)가 다시 채운다.
            if rnd == 0 and code in (500, 502, 503, 504):
                log("  · 잠시 쉽니다(15초) 뒤 한 바퀴 더 시도")
                time.sleep(15)
            else:
                break
        raise RuntimeError(f"Gemini 호출 실패: {last}")

    # CLI 대체 경로 (gemini CLI 로그인돼 있으면 API 키 없이도 동작)
    if cfg["summary"]["provider"] in ("auto", "cli"):
        text = "\n".join(p.get("text", "") for p in parts if "text" in p)
        if not text:
            raise RuntimeError("CLI 요약에는 텍스트 입력만 지원합니다(오디오는 API 키 필요).")
        try:
            out = subprocess.run([cfg.get("gemini_cli", "gemini"), "-p", text],
                                 capture_output=True, text=True, timeout=600)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip()
            raise RuntimeError(out.stderr.strip()[:300] or "gemini CLI 실패")
        except FileNotFoundError:
            pass
    raise RuntimeError("Gemini API 키가 없습니다. export GEMINI_API_KEY=... 또는 config 의 summary.api_key")


def gemini_files_upload(data: bytes, name: str, mime: str, cfg: dict) -> str:
    """20MB 초과 오디오용 Files API 업로드 → 파일 URI."""
    key = os.environ.get(cfg["summary"]["api_key_env"]) or cfg["summary"].get("api_key")
    if not key:
        raise RuntimeError("긴 오디오 전사에는 Gemini API 키가 필요합니다.")
    meta = json.dumps({"file": {"display_name": name}}).encode()
    boundary = "hemory" + hashlib.md5(data[:64] + name.encode()).hexdigest()[:10]
    body = (b"--" + boundary.encode() + b"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta +
            b"\r\n--" + boundary.encode() + b"\r\nContent-Type: " + mime.encode() + b"\r\n\r\n" + data +
            b"\r\n--" + boundary.encode() + b"--")
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=" + urllib.parse.quote(key),
        data=body, headers={"Content-Type": f"multipart/related; boundary={boundary}"}, method="POST")
    with urllib.request.urlopen(req, timeout=900) as r:
        j = json.loads(r.read())
    f = j.get("file", {})
    uri, state, fname = f.get("uri"), f.get("state"), f.get("name")
    for _ in range(120):
        if state == "ACTIVE":
            return uri
        time.sleep(2)
        req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/{fname}?key=" + urllib.parse.quote(key))
        with urllib.request.urlopen(req, timeout=60) as r:
            state = json.loads(r.read()).get("state")
    raise RuntimeError("오디오 처리 상태가 ACTIVE 가 되지 않았습니다.")


def transcribe_gemini(item: dict, data: bytes, cfg: dict) -> dict:
    mime = mimetypes.guess_type(item["name"])[0] or "audio/mp4"
    prompt = (
        "다음 한국어(또는 한국어+영어) 녹음을 전사하고 정리해 JSON 하나로만 답하라.\n"
        "형식: {\"language\":\"ko\",\"segments\":[{\"start\":0.0,\"end\":3.4,\"speaker\":\"화자 1\",\"text\":\"문장\"}]}\n"
        "규칙: 실제로 들린 말만, 추측 금지, 시간은 초 단위 숫자, 문장은 3~12초 호흡 단위, "
        "말이 없는 구간은 넣지 않는다. 두 사람 이상이면 목소리로 구분해 화자 1/화자 2로 표시하고, "
        "확실치 않으면 화자로 표기한다."
    )
    if len(data) <= 18 * 1024 * 1024:
        part = {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}
    else:
        uri = gemini_files_upload(data, item["name"], mime, cfg)
        part = {"file_data": {"mime_type": mime, "file_uri": uri}}
    out = gemini_generate([{"text": prompt}, part], cfg, json_mode=True)
    j = json.loads(out[out.find("{") : out.rfind("}") + 1])
    segs = []
    for s in j.get("segments", []):
        t = str(s.get("text", "")).strip()
        if t:
            segs.append({"i": len(segs), "start": round(float(s.get("start") or 0), 2),
                         "end": round(float(s.get("end") or 0), 2) or None,
                         "speaker": s.get("speaker") or "", "text": t})
    return {"segments": segs, "language": j.get("language", "ko"),
            "engine": {"asr": "gemini", "model": cfg["summary"]["model"]}}


def diarize(segs: list[dict], data: bytes, item: dict, cfg: dict) -> tuple[list[dict], str]:
    """화자 구분. pyannote → gemini(추정) → 없음."""
    method = cfg["diarization"]["method"]
    has_speakers = any(s.get("speaker") for s in segs)
    if has_speakers:
        return segs, "asr"
    if method in ("auto", "pyannote"):
        try:
            from pyannote.audio import Pipeline  # type: ignore
            token = os.environ.get("HF_TOKEN") or cfg["diarization"].get("hf_token")
            if not token:
                raise RuntimeError("HF_TOKEN 없음")
            from faster_whisper import decode_audio  # type: ignore
            tmp = STATE_DIR / "tmp" / item["name"]
            tmp.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(data, (bytes, bytearray)):
                tmp.write_bytes(data)
            pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
            ann = pipe(str(tmp))
            turns = [(t.start, t.end, spk) for t, _, spk in ann.itertracks(yield_label=True)]
            for s in segs:
                mid = (s["start"] + (s["end"] or s["start"])) / 2
                votes = [spk for a, b, spk in turns if a <= mid <= b]
                if votes:
                    s["speaker"] = votes[0].replace("SPEAKER_", "화자 ")
            return segs, "pyannote"
        except Exception as e:
            if method == "pyannote":
                log(f"  · pyannote 실패: {e}")
    if method in ("auto", "gemini"):
        try:
            text = "\n".join(f"{i}\t{s['start']}\t{s['text']}" for i, s in enumerate(segs))
            prompt = ("아래는 한국어 녹음의 전사문이다. 각 줄 앞 번호를 유지하며, 목소리가 바뀌는 지점을 추정해 "
                      "화자를 배정하라. 최대 4명. 확실하지 않은 줄은 직전 화자를 유지하라. "
                      "출력은 JSON 배열만: [{\"i\":0,\"speaker\":\"화자 1\"}, ...]\n\n" + text)
            out = gemini_generate([{"text": prompt}], cfg, json_mode=True)
            arr = json.loads(out[out.find("[") : out.rfind("]") + 1])
            m = {int(x["i"]): x.get("speaker", "") for x in arr if "i" in x}
            for i, s in enumerate(segs):
                s["speaker"] = m.get(i, s.get("speaker", "")) or ""
            return segs, "gemini-estimated"
        except Exception as e:
            log(f"  · 화자 추정 생략: {e}")
    return segs, "none"


# ─────────────────────────────────────────── 요약
SUMMARY_PROMPT = """너는 사용자 본인의 개인 녹음을 정리하는 비서다. 아래 전사문을 읽고 JSON 하나로만 답하라.

{{
  "title": "내용을 12자 내외로 요약한 제목",
  "type": "meeting|work|meal|daily|study|etc",
  "one_line": "한 문장 요약",
  "bullets": ["핵심 3~5개"],
  "agenda": ["회의일 때 안건"],
  "decisions": ["회의일 때 결정 사항"],
  "actions": [{{"owner":"","task":"","due":""}}],
  "keywords": ["키워드 5개"]
}}

규칙:
- 전사문에 없는 내용은 쓰지 않는다. 이름·날짜·숫자는 들린 그대로.
- 회의(meeting)면 agenda·decisions·actions 를 채우고, 일상·식사·업무 메모면 bullets 중심으로 짧게.
- type 판단: 여러 사람이 안건을 논의하면 meeting, 혼자 말한 업무 메모면 work, 식사·약속은 meal,
  개인적인 일상은 daily, 강의·공부는 study.
- 한국어 존댓말, 과장 없이.

전사문({n}문장):
{transcript}"""


def summarize(segs: list[dict], cfg: dict, hint: str = "") -> dict:
    transcript = "\n".join(f"[{s['start']:.0f}s] {s.get('speaker','')}: {s['text']}" for s in segs)
    head = transcript[:60000]
    prompt = SUMMARY_PROMPT.format(n=len(segs), transcript=head)
    if hint:
        prompt += f"\n참고: {hint}"
    out = gemini_generate([{"text": prompt}], cfg, json_mode=True)
    try:
        j = json.loads(out[out.find("{") : out.rfind("}") + 1])
    except Exception:
        return {"one_line": "", "bullets": [], "agenda": [], "decisions": [], "actions": [], "keywords": []}
    if j.get("type") not in TYPES:
        j["type"] = "etc"
    return j


# ─────────────────────────────────────────── 처리
def build_record(item: dict, segs: list[dict], info: dict, summary: dict, diar: str,
                 type_hint: str | None, started: dt.datetime, data_len: int) -> dict:
    dur = max([s.get("end") or s.get("start") or 0 for s in segs], default=0)
    # whisper VAD 를 거친 구간의 합 = '말한 구간'의 정식 값(앱의 실시간 측정과 별개, v1.6.1)
    speech = sum(max(0.0, (s.get("end") or 0) - (s.get("start") or 0)) for s in segs)
    rid = item["base"]
    title = summary.get("title") or f"{started:%m월 %d일} 기록"
    rtype = type_hint or summary.get("type") or "etc"
    if rtype not in TYPES:
        rtype = "etc"
    return {
        "schema": "hemory.transcript.v1",
        "id": rid,
        "title": title,
        "type": rtype,
        "started_at": iso_local(started),
        "duration_sec": int(round(dur)),
        "speech_sec": int(round(speech)),
        "source": "iphone" if item.get("from_inbox") else "web",
        "status": "done",
        "language": info.get("language", "ko"),
        "summary": {
            "one_line": summary.get("one_line", ""),
            "bullets": summary.get("bullets") or [],
            "agenda": summary.get("agenda") or [],
            "decisions": summary.get("decisions") or [],
            "actions": summary.get("actions") or [],
            "keywords": summary.get("keywords") or [],
        },
        "speakers": sorted({s.get("speaker") for s in segs if s.get("speaker")}),
        "segments": [{"i": i, "start": s["start"], "end": s.get("end"), "speaker": s.get("speaker", ""), "text": s["text"]}
                     for i, s in enumerate(segs)],
        "audio": {"file_name": item["name"], "size": data_len,
                  **({"file_id": item["id"]} if item.get("id") else {})},
        "engine": {**info.get("engine", {}), "diarization": diar, "summary": cfg_model()},
        "processed_at": now_local().isoformat(timespec="seconds"),
    }


_CFG_REF: dict = {}
def cfg_model() -> str:
    return _CFG_REF.get("summary", {}).get("model", "")


def pick_engine(cfg: dict) -> str:
    eng = cfg["asr"]["engine"]
    if eng != "auto":
        return eng
    try:
        import faster_whisper  # noqa: F401
        return "whisper"
    except ImportError:
        return "gemini"


def _move_to(be, item: dict, dest) -> str:
    """로컬/드라이브 공통 이동."""
    if be.kind == "local":
        dest = Path(dest)
        dest.mkdir(parents=True, exist_ok=True)
        target = dest / item["name"]
        if target.exists() and Path(item["path"]) != target:
            target = dest / f"{Path(item['name']).stem}-{int(time.time())}{Path(item['name']).suffix}"
        shutil.move(str(item["path"]), str(target))
        item["path"] = target
        return str(target)
    return be.move(item, dest)


def _tidy_duplicate(be, item: dict, cfg: dict, month) -> str:
    """이미 전사 JSON 이 있는 오디오가 `_inbox` 에 남았을 때 정리한다.

    예전 코드는 `has_json` 이면 그냥 return 해서 그 파일이 `_inbox` 에 영구히 고착됐다
    (12:44·13:14·13:45·14:15 실행 모두 "inbox 오디오 1개 / 완료 0건").
      · 월 폴더에 같은 이름 오디오가 없으면 → 월 폴더로 옮긴다(제자리 찾기).
      · 이미 있으면 → 중복 사본이므로 `_trash` 로 보낸다(드라이브 휴지통 30일 복원 가능).
    """
    if not item.get("from_inbox"):
        return ""
    try:
        names = {a["name"] for a in be.list_audio(month)}
        if item["name"] in names:
            _move_to(be, item, be.folder(cfg.get("trash", "_trash")))
            return "중복 사본 → 휴지통"
        _move_to(be, item, month)
        return "월 폴더로 이동"
    except Exception as e:
        return f"정리 실패({e})"


def process_one(be, item: dict, cfg: dict, dry: bool = False, force: bool = False) -> str | None:
    name = item["name"]
    started = parse_stamp(item["base"]) or item["created"].astimezone()
    month = be.month_folder(started)
    if be.has_json(month, item["base"]) and not force:
        if not dry:
            note = _tidy_duplicate(be, item, cfg, month)
            if note:
                log(f"  · 이미 전사된 파일: {name} → {note}")
        return None

    if dry:
        log(f"  [dry] 처리 예정: {name} ({item['size']/1e6:.1f}MB, {started:%Y-%m-%d %H:%M})")
        return None

    log(f"  · 읽는 중: {name} ({item['size']/1e6:.1f}MB)")
    data = be.read_bytes(item)
    engine = pick_engine(cfg)
    if engine == "mock":
        log("  · [MOCK] 가짜 전사 (로직 검증용)")
        info = {"segments": [
            {"i": 0, "start": 0.6, "end": 5.2, "speaker": "화자 1", "text": "이것은 파이프라인 로직 검증용 가짜 전사입니다."},
            {"i": 1, "start": 6.0, "end": 11.4, "speaker": "화자 2", "text": "JSON 생성과 폴더 이동이 정상인지 확인합니다."},
        ], "language": "ko", "engine": {"asr": "mock"}}
    elif engine == "whisper":
        log("  · 전사: faster-whisper")
        info = transcribe_whisper(data, cfg, name)
    else:
        log("  · 전사: gemini")
        info = transcribe_gemini(item, data, cfg)
    segs = info["segments"]
    if not segs:
        # 무음(마이크가 죽었거나 말이 없음) → 매 실행마다 다시 전사하지 않도록 휴지통으로 보낸다.
        # 드라이브 휴지통은 30일 안에 복원할 수 있다.
        try:
            trash = be.folder(cfg.get("trash", "_trash"))
            if be.kind == "local":
                if Path(item["path"]).parent != trash:
                    shutil.move(item["path"], Path(trash) / item["name"])
            elif item.get("folder_id") != trash:
                be.move(item, trash)
            log("  · 문장이 없습니다(무음) → 휴지통으로 이동")
        except Exception as e:
            log(f"  · 문장이 없습니다. 건너뜀 (이동 실패: {e})")
        return None

    segs, diar = diarize(segs, data, item, cfg)
    log(f"  · 화자: {diar}, 문장 {len(segs)}개")

    hint = f"파일 이름: {name}"
    if engine == "mock":
        summary = {"title": "로직 검증 기록", "type": "work", "one_line": "가짜 요약입니다.",
                   "bullets": ["JSON 생성 확인", "이동 확인"], "agenda": [], "decisions": [],
                   "actions": [{"owner": "", "task": "검증", "due": ""}], "keywords": ["검증", "테스트"]}
    else:
      try:
        summary = summarize(segs, cfg, hint=hint)
      except Exception as e:
        log(f"  · 요약 실패({e}) → 전사만 저장")
        summary = {"one_line": "", "bullets": [], "agenda": [], "decisions": [], "actions": [], "keywords": []}

    type_hint = None
    m = re.match(r"^\d{8}-\d{4}_([a-z]+)_", name)
    if m and m.group(1) in TYPES:
        type_hint = m.group(1)

    rec = build_record(item, segs, info, summary, diar, type_hint, started, len(data))
    be.write_json(month, f"{item['base']}.json", rec)
    log(f"  · 저장: {rec['title']} [{rec['type']}] {rec['duration_sec']}초")

    if be.kind == "local":
        needs_move = Path(item["path"]).parent != month
    else:
        needs_move = item.get("folder_id") != month
    if needs_move:
        try:
            be.move(item, month)
            log("  · 오디오를 월 폴더로 이동")
        except Exception as e:
            log(f"  · 이동 실패(무시): {e}")
    return item["base"]


def list_month_folders(be) -> list:
    """YYYY-MM 이름의 폴더 목록."""
    pat = re.compile(r"^\d{4}-\d{2}$")
    if be.kind == "local":
        return [p for p in be.root.glob("*") if p.is_dir() and pat.match(p.name)]
    root = be.root()
    q = (f"'{root}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false")
    j = be._req("GET", f"{be.API}/files?q={urllib.parse.quote(q)}&fields=files(id,name)&pageSize=200")
    return [(f["id"], f["name"]) for f in j.get("files", []) if pat.match(f["name"])]


_SIZE_SEEN: dict[str, tuple[int, float, float]] = {}


def _age_sec(it: dict) -> float | None:
    """드라이브가 알려 준 수정/생성 시각 기준 경과 초."""
    mt = it.get("modifiedTime") or it.get("createdTime")
    if not mt:
        return None
    try:
        t = dt.datetime.fromisoformat(str(mt).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
    except Exception:
        return None
    return (dt.datetime.now(dt.timezone.utc) - t).total_seconds()


def _too_fresh(it: dict, sec: int | None = None, need_stable: bool = False) -> bool:
    """방금 올라와 아직 쓰이고 있을 수 있는 파일인가(업로드 중 집어가면 잘린 파일이 된다).

    · GROWING_SKIP_SEC(기본 10초) 안에 올라온 파일은 무조건 다음 차례로 미룬다.
    · need_stable(상주 감시)이면 한 번 더 지켜본다: 이전 폴링에서 본 크기와 같아야 처리한다.
      (15초 폴링이면 새 파일은 보통 다음 회차에 바로 처리된다)
    """
    sec = GROWING_SKIP_SEC if sec is None else sec
    now = time.time()
    key = str(it.get("id") or it.get("name") or "")
    size = int(it.get("size") or 0)
    prev = _SIZE_SEEN.get(key)
    # 같은 크기를 계속 보고 있으면 첫 관측 시각을 유지한다(그래야 '얼마나 지켜봤는지'가 된다)
    if prev and prev[0] == size:
        first, last = prev[1], now
    else:
        first, last = now, now
    _SIZE_SEEN[key] = (size, first, last)
    if len(_SIZE_SEEN) > 2000:                     # 오래 본 이름은 버린다(메모리 고정 방지)
        for k, (_s, _f, t) in list(_SIZE_SEEN.items()):
            if now - t > 3600:
                _SIZE_SEEN.pop(k, None)
    age = _age_sec(it)
    if age is not None and age < sec:
        return True
    if not need_stable:
        return False
    seen_before = prev is not None and prev[0] == size
    return not (seen_before and (now - prev[1]) >= GROWING_STABLE_SEC)


def scan_inbox(be, cfg: dict, need_stable: bool = False, quiet: bool = False) -> list[dict]:
    inbox = be.folder(cfg["inbox"])
    items = []
    for it in be.list_audio(inbox):
        if _too_fresh(it, need_stable=need_stable):
            if not quiet:
                log(f"  · 아직 올라오는 중: {it['name']} (다음 실행에 처리)")
            continue
        it["from_inbox"] = True
        items.append(it)
    # 월 폴더에 오디오만 있고 JSON 이 없는 경우(업로드 중단·수동 복사)도 복구
    #   (JSON 이름은 폴더마다 한 번에 읽어 온다 — 파일마다 드라이브를 묻으면 회차가 20초씩 길어진다)
    for folder_id, _name in list_month_folders(be):
        try:
            have = {j["base"] for j in be.list_json(folder_id)} if hasattr(be, "list_json") else set()
        except Exception:
            have = set()
        for it in be.list_audio(folder_id):
            if it["base"] in have:
                continue
            if not _too_fresh(it, need_stable=need_stable):
                it["from_inbox"] = False
                items.append(it)
    return items


def run_once(cfg: dict, dry: bool = False, limit: int | None = None, force: bool = False,
             quiet: bool = False, need_stable: bool = False) -> int:
    global _CFG_REF
    _CFG_REF = cfg
    ensure_dirs(cfg)

    # 데드맨 스위치: 마지막 성공이 너무 오래됐으면 한 번 알린다(6시간 간격)
    st = read_status()
    last_ok = st.get("last_success_at") or ""
    warn_at = st.get("last_deadman_warn") or ""
    try:
        if last_ok:
            age = time.time() - dt.datetime.fromisoformat(last_ok).timestamp()
            warned = time.time() - dt.datetime.fromisoformat(warn_at).timestamp() if warn_at else 1e9
            if age > DEADMAN_SEC and warned > 6 * 3600:
                log(f"! 마지막 성공 후 {age/3600:.1f}시간 경과 — 확인이 필요합니다")
                notify_mac(f"Hemory 전사가 {age/3600:.0f}시간째 성공하지 못했습니다", "Hemory 점검 필요")
                write_status(last_deadman_warn=dt.datetime.now().astimezone().isoformat(timespec="seconds"))
    except Exception:
        pass

    fd = acquire_lock()
    if fd is None and not dry:
        if not quiet:
            log("이미 실행 중인 파이프라인이 있어 건너뜁니다(락 파일)")
        return 0
    try:
        be = make_backend(cfg)
        where = be.root if be.kind == "local" else f"{cfg['root_name']} (drive)"
        if not quiet:
            log(f"백엔드={be.kind} 루트={where}")

        items = scan_inbox(be, cfg, need_stable=need_stable, quiet=quiet)
        if not quiet:
            log(f"inbox 오디오 {len(items)}개")
        if limit:
            items = items[:limit]
        done = 0
        for it in items:
            try:
                if process_one(be, it, cfg, dry=dry, force=force):
                    done += 1
            except AuthError:
                raise
            except Exception as e:
                log(f"  ! 실패 {it['name']}: {e}")
        if not quiet or done:
            log(f"완료 {done}건")
        if not dry:
            write_status(
                ok=True,
                last_success_at=dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                last_error="",
                last_error_kind="",
                processed=done,
            )
        return done
    except AuthError as e:
        log(f"! 인증 실패 — 전사 중단: {e}")
        if not dry:
            write_status(
                ok=False,
                last_error=str(e),
                last_error_kind="auth",
                last_failure_at=dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            )
            notify_mac("Google 재인증이 필요해 전사가 멈췄습니다", "Hemory 인증 만료")
        return 0
    except Exception as e:
        log(f"! 실행 실패: {e}")
        if not dry:
            write_status(
                ok=False,
                last_error=str(e),
                last_error_kind="other",
                last_failure_at=dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            )
        raise
    finally:
        release_lock(fd)


# ─────────────────────────────── 다시 요약 / 상주 감시 (v1.6)
def needs_summary(rec: dict) -> bool:
    """요약·제목이 비었거나 기본 제목으로 남은 기록인가.

    Gemini 503/429 때 전사만 저장되면 제목이 "11월 26일 기록" 으로 남는다.
    """
    s = rec.get("summary") or {}
    if not str(s.get("one_line") or "").strip():
        return True
    t = str(rec.get("title") or "").strip()
    if not t:
        return True
    return bool(re.match(r"^\d{1,2}월\s*\d{1,2}일 기록$", t))


def _month_pairs(be) -> list[tuple]:
    """(폴더 참조, 폴더 이름) — 로컬은 Path, 드라이브는 폴더 id."""
    if be.kind == "local":
        return [(p, p.name) for p in list_month_folders(be)]
    return list(list_month_folders(be))


def _read_json_item(be, folder, item: dict) -> dict | None:
    try:
        if be.kind == "local":
            return json.loads(Path(item["path"]).read_text(encoding="utf-8"))
        return json.loads(be.read_bytes(item))
    except Exception as e:
        log(f"  ! JSON 읽기 실패 {item['name']}: {e}")
        return None


def resummarize(be, cfg: dict, since: dt.date | None = None, until: dt.date | None = None,
                dry: bool = False, limit: int | None = None, diarize_again: bool = False) -> int:
    """전사는 됐지만 요약·제목이 빈 기록을 다시 요약해 같은 JSON 을 갱신한다."""
    global _CFG_REF
    _CFG_REF = cfg
    done = 0
    for folder, mname in _month_pairs(be):
        try:
            ym = (int(mname[:4]), int(mname[5:7]))
        except Exception:
            continue
        if since and ym < (since.year, since.month):
            continue
        if until and ym > (until.year, until.month):
            continue
        for item in be.list_json(folder):
            base = item["base"]
            day = None
            mm = re.match(r"^(\d{4})(\d{2})(\d{2})", base)
            if mm:
                try:
                    day = dt.date(int(mm.group(1)), int(mm.group(2)), int(mm.group(3)))
                except Exception:
                    day = None
            if since and day and day < since:
                continue
            if until and day and day > until:
                continue
            rec = _read_json_item(be, folder, item)
            if not rec or not needs_summary(rec):
                continue
            segs = rec.get("segments") or []
            if not segs:
                log(f"  · 문장이 없어 건너뜀: {item['name']}")
                continue
            if dry:
                log(f"  [dry] 다시 요약: {item['name']} (문장 {len(segs)}개)")
                continue
            log(f"  · 다시 요약: {item['name']} (문장 {len(segs)}개)")
            diar = (rec.get("engine") or {}).get("diarization", "none")
            work = [dict(s) for s in segs]
            if diarize_again and not any(s.get("speaker") for s in work):
                try:
                    audio = next((a for a in be.list_audio(folder) if a["base"] == base), None)
                    data = be.read_bytes(audio) if audio else b""
                    work, diar = diarize(work, data, audio or {"name": item["name"]}, cfg)
                    log(f"  · 화자: {diar}")
                except Exception as e:
                    log(f"  · 화자 추정 생략: {e}")
            try:
                summary = summarize(work, cfg, hint=f"파일 이름: {item['name']}")
            except Exception as e:
                log(f"  ! 요약 실패 {item['name']}: {e}")
                continue
            if not str(summary.get("one_line") or "").strip():
                log(f"  ! 요약이 비어 있음(모델 응답 없음): {item['name']}")
                continue
            rec["title"] = summary.get("title") or rec.get("title") or f"{base[:8]} 기록"
            if summary.get("type") in TYPES:
                rec["type"] = summary["type"]
            rec["summary"] = {
                "one_line": summary.get("one_line", ""),
                "bullets": summary.get("bullets") or [],
                "agenda": summary.get("agenda") or [],
                "decisions": summary.get("decisions") or [],
                "actions": summary.get("actions") or [],
                "keywords": summary.get("keywords") or [],
            }
            if diarize_again:
                rec["segments"] = [{"i": s.get("i", i), "start": s.get("start"), "end": s.get("end"),
                                    "speaker": s.get("speaker", ""), "text": s.get("text", "")}
                                   for i, s in enumerate(work)]
                rec["speakers"] = sorted({s.get("speaker") for s in work if s.get("speaker")})
                rec.setdefault("engine", {})["diarization"] = diar
            rec.setdefault("engine", {})["summary"] = cfg_model()
            rec["resummarized_at"] = now_local().isoformat(timespec="seconds")
            try:
                be.write_json(folder, item["name"], rec)
            except Exception as e:
                log(f"  ! 저장 실패 {item['name']}: {e}")
                continue
            log(f"  · 갱신: {rec['title']} [{rec.get('type')}] · {rec['summary']['one_line'][:60]}")
            done += 1
            time.sleep(2)                        # 무료 티어 분당 한도에 걸리지 않게 간격을 둔다
            if limit and done >= limit:
                return done
    return done


_STOP = {"flag": False}


def _install_stop_handlers() -> None:
    import signal as _sig

    def _handler(signum, _frame):
        _STOP["flag"] = True
        log(f"종료 신호({signum}) — 이번 회차를 마치고 멈춥니다")

    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        sig = getattr(_sig, name, None)
        if sig is None:
            continue
        try:
            _sig.signal(sig, _handler)
        except Exception:
            pass


def _sleep_until_stop(sec: float) -> None:
    end = time.time() + sec
    while not _STOP["flag"] and time.time() < end:
        time.sleep(max(0.05, min(0.5, end - time.time())))


def _run_prune(config_path: Path | None) -> None:
    prune = Path(__file__).with_name("hemory_prune.py")
    if not prune.exists():
        return
    cmd = [sys.executable, str(prune), "--purge"]
    if config_path:
        cmd += ["--config", str(config_path)]
    log("· 365일 정리(prune) 실행")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        for line in (r.stdout or "").strip().splitlines()[-3:]:
            log("  " + line)
        if r.returncode != 0:
            log(f"  ! prune 실패({r.returncode}): {(r.stderr or '').strip()[:200]}")
    except Exception as e:
        log(f"  ! prune 실행 실패: {e}")


def watch(cfg: dict, interval: int = WATCH_INTERVAL_SEC, dry: bool = False, limit: int | None = None,
          force: bool = False, config_path: Path | None = None) -> None:
    """상주 감시(준실시간). 모델을 시작할 때 한 번만 올리고 interval 초마다 _inbox 를 훑는다."""
    global _CFG_REF
    _CFG_REF = cfg
    _install_stop_handlers()
    log(f"상주 감시 시작 · {interval}초 간격 · 엔진={pick_engine(cfg)} · pid={os.getpid()}")
    if pick_engine(cfg) == "whisper":
        try:
            _whisper_model(cfg)
            log("  · whisper 준비 완료(이후 회차는 재로드 없음)")
        except Exception as e:
            log(f"! whisper 모델 로드 실패: {e}")
    write_status(watch_pid=os.getpid(),
                 watch_started_at=now_local().isoformat(timespec="seconds"),
                 watch_interval_sec=interval)
    last_beat = 0.0
    last_prune = 0.0
    last_resum = time.time()          # 시작 직후엔 몰아서 하지 않는다(전사 우선)
    cycles = 0
    total_done = 0
    while not _STOP["flag"]:
        t0 = time.time()
        n = 0
        try:
            n = run_once(cfg, dry=dry, limit=limit, force=force, quiet=True, need_stable=True)
            total_done += n
        except AuthError as e:
            log(f"! 인증 실패 — 감시는 유지: {e}")
        except Exception as e:
            log(f"! 감시 중 오류: {e}")
        cycles += 1
        now = time.time()
        if n:
            write_status(watch_pid=os.getpid(), watch_cycles=cycles,
                         watch_processed_total=total_done,
                         watch_last_work_at=now_local().isoformat(timespec="seconds"))
        if now - last_beat >= WATCH_HEARTBEAT_SEC:
            write_status(watch_pid=os.getpid(), watch_cycles=cycles,
                         watch_heartbeat_at=now_local().isoformat(timespec="seconds"),
                         watch_processed_total=total_done)
            st = read_status()
            log(f"대기 중 · {cycles}회 확인 · 누적 처리 {total_done}건 · 마지막 성공 {st.get('last_success_at', '-')}")
            last_beat = now
        if now - last_prune >= PRUNE_INTERVAL_SEC:
            _run_prune(config_path)
            last_prune = time.time()
        # Gemini 장애로 요약만 빈 기록을 스스로 다시 채운다(오늘 것만·한 번에 5건)
        if now - last_resum >= RESUMMARIZE_INTERVAL_SEC:
            last_resum = time.time()
            try:
                be2 = make_backend(cfg)
                today = now_local().date()
                n2 = resummarize(be2, cfg, since=today, until=today, limit=5, diarize_again=False)
                if n2:
                    log(f"· 요약이 비어 있던 기록 {n2}건을 채웠습니다")
                    write_status(watch_last_resummarize_at=now_local().isoformat(timespec="seconds"),
                                 watch_resummarized_total=n2)
            except Exception as e:
                log(f"! 다시 요약 실패(다음 회차에 재시도): {e}")
        _sleep_until_stop(max(1.0, interval - (time.time() - t0)))
    log(f"상주 감시 종료 · {cycles}회 확인 · 누적 처리 {total_done}건")
    write_status(watch_pid=0, watch_stopped_at=now_local().isoformat(timespec="seconds"))


def main() -> None:
    ap = argparse.ArgumentParser(description="Hemory 개인용 전사·요약 파이프라인")
    ap.add_argument("--once", action="store_true", help="한 번만 실행 (기본)")
    ap.add_argument("--config", type=Path, default=None)
    ap.add_argument("--backend", choices=["local", "drive"], default=None)
    ap.add_argument("--root", default=None, help="local 백엔드의 폴더 경로")
    ap.add_argument("--engine", choices=["auto", "whisper", "gemini", "mock"], default=None,
                    help="mock 은 모델 없이 파이프라인 로직만 검사할 때만 사용")
    ap.add_argument("--model", default=None, help="whisper 모델(medium, large-v3-turbo …)")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--force", action="store_true", help="JSON 이 있어도 다시 처리")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--watch", action="store_true", help="상주 감시 — 15초마다 _inbox 를 훑는다(모델 1회 로드)")
    ap.add_argument("--interval", type=int, default=WATCH_INTERVAL_SEC, help="상주 감시 폴링 간격(초)")
    ap.add_argument("--resummarize", action="store_true", help="요약·제목이 빈 기록을 다시 요약")
    ap.add_argument("--since", default=None, help="다시 요약 대상 시작일 YYYY-MM-DD")
    ap.add_argument("--until", default=None, help="다시 요약 대상 종료일 YYYY-MM-DD")
    ap.add_argument("--diarize", action="store_true", help="다시 요약할 때 화자도 다시 추정")
    ap.add_argument("--self-test", action="store_true", help="엔진 없이 파이프라인 로직만 검사")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.backend:
        cfg["backend"] = args.backend
    if args.root:
        cfg["local_root"] = args.root
    if args.engine:
        cfg["asr"]["engine"] = args.engine
    if args.model:
        cfg["asr"]["whisper_model"] = args.model

    if args.self_test:
        self_test(cfg)
        return

    if args.resummarize:
        be = make_backend(cfg)
        since = dt.date.fromisoformat(args.since) if args.since else None
        until = dt.date.fromisoformat(args.until) if args.until else None
        n = resummarize(be, cfg, since=since, until=until, dry=args.dry_run,
                        limit=args.limit, diarize_again=args.diarize)
        log(f"다시 요약 완료 {n}건")
        return

    if args.watch:
        watch(cfg, interval=args.interval, dry=args.dry_run, limit=args.limit,
              force=args.force, config_path=args.config)
        return

    run_once(cfg, dry=args.dry_run, limit=args.limit, force=args.force)


def self_test(cfg: dict) -> None:
    """모델·API 없이 폴더 구조/JSON 생성/이동 로직을 검증 (가짜 전사문 사용)."""
    import tempfile
    global _CFG_REF
    _CFG_REF = cfg
    tmp = Path(tempfile.mkdtemp(prefix="hemory-selftest-"))
    (tmp / "_inbox").mkdir()
    (tmp / "_inbox" / "20261124-0930_meeting_selftest.m4a").write_bytes(b"\x00" * 2048)
    be = LocalBackend(str(tmp))
    items = be.list_audio(be.folder("_inbox"))
    assert len(items) == 1, "inbox 스캔 실패"
    item = items[0]
    segs = [
        {"i": 0, "start": 1.0, "end": 6.2, "speaker": "화자 1", "text": "오늘 점검 범위를 먼저 정하겠습니다."},
        {"i": 1, "start": 7.0, "end": 13.5, "speaker": "화자 2", "text": "배관 두 구간은 지난주에 끝났습니다."},
    ]
    summary = {"title": "일일 점검 회의", "type": "meeting", "one_line": "점검 범위와 완료 구간을 확인했다.",
               "bullets": ["배관 두 구간 완료"], "agenda": ["점검 범위"], "decisions": ["오늘 범위 확정"],
               "actions": [{"owner": "담당", "task": "잔여 구간 확인", "due": "오늘"}], "keywords": ["점검", "배관"]}
    started = parse_stamp(item["base"])
    rec = build_record(item, segs, {"language": "ko", "engine": {"asr": "self-test"}}, summary, "self-test", None, started, 2048)
    month = be.month_folder(started)
    be.write_json(month, f"{item['base']}.json", rec)
    be.move(item, month)
    assert (month / f"{item['base']}.json").exists(), "JSON 생성 실패"
    assert (month / item["name"]).exists(), "오디오 이동 실패"
    assert not (tmp / "_inbox" / item["name"]).exists(), "inbox 정리 실패"
    saved = json.loads((month / f"{item['base']}.json").read_text(encoding="utf-8"))
    assert saved["segments"][1]["text"].startswith("배관"), "전사문 저장 실패"
    assert saved["summary"]["actions"][0]["task"] == "잔여 구간 확인", "요약 저장 실패"
    assert saved["type"] == "meeting"
    shutil.rmtree(tmp)
    print("self-test 통과: inbox 스캔 → JSON 생성 → 월 폴더 이동 → 내용 검증")


if __name__ == "__main__":
    main()
