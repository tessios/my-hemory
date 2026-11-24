#!/usr/bin/env python3
"""
Hemory 개인용 — 365일 지난 녹음 자동 정리
=======================================

`Hemory-개인녹음/` 아래에서 만든 지 N일(기본 365일)이 지난 오디오와 그 전사 JSON 을
`_trash/YYYY-MM/` 로 옮깁니다. `--purge` 를 주면 `_trash` 안에서 다시 N일(기본 30일) 지난 것을 실제로 삭제합니다.
(구글 드라이브 백엔드에서는 실제 삭제 대신 휴지통 이동을 씁니다.)

사용 예
  python3 hemory_prune.py --dry-run          # 무엇이 정리될지 미리 보기
  python3 hemory_prune.py                    # 365일 지난 것 → _trash 로 이동
  python3 hemory_prune.py --purge            # _trash 에서 30일 지난 것 삭제
  python3 hemory_prune.py --backend drive --days 365
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import time
import urllib.parse
from pathlib import Path

from hemory_pipeline import (
    AUDIO_EXT, CONFIG_PATH, STATE_DIR, DriveBackend, LocalBackend, ensure_dirs,
    iso_local, load_config, log, make_backend, now_local,
)

MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def age_days(ts: float) -> float:
    return (time.time() - ts) / 86400


def prune_local(be: LocalBackend, cfg: dict, days: int, dry: bool, purge_days: int | None) -> dict:
    root = be.root
    trash_root = root / cfg["trash"]
    moved, purged, kept = [], [], 0

    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or folder.name == cfg["trash"]:
            continue
        for p in sorted(folder.iterdir()):
            if not p.is_file():
                continue
            if p.suffix.lower() not in AUDIO_EXT and p.suffix.lower() != ".json":
                continue
            created = min(p.stat().st_ctime, p.stat().st_mtime)
            if age_days(created) < days:
                kept += 1
                continue
            dest_dir = trash_root / f"{dt.datetime.fromtimestamp(created):%Y-%m}"
            moved.append({"file": str(p), "age_days": round(age_days(created), 1), "dest": str(dest_dir / p.name)})
            if not dry:
                dest_dir.mkdir(parents=True, exist_ok=True)
                p.rename(dest_dir / p.name)

    if purge_days is not None and trash_root.exists():
        for p in sorted(trash_root.rglob("*")):
            if p.is_file() and age_days(p.stat().st_mtime) >= purge_days:
                purged.append(str(p))
                if not dry:
                    p.unlink()
        if not dry:
            for d in sorted(trash_root.rglob("*"), reverse=True):
                if d.is_dir() and not any(d.iterdir()):
                    d.rmdir()

    return {"moved": moved, "purged": purged, "kept": kept}


def prune_drive(be: DriveBackend, cfg: dict, days: int, dry: bool, purge_days: int | None) -> dict:
    moved, purged, kept = [], [], 0
    cutoff = now_local() - dt.timedelta(days=days)
    root = be.root()
    q = f"'{root}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'"
    j = be._req("GET", f"{be.API}/files?q={q}&fields=files(id,name)&pageSize=200")
    folders = [(f["id"], f["name"]) for f in j.get("files", []) if MONTH_RE.match(f["name"])]

    for fid, fname in folders:
        items = be.list_audio(fid)
        # 같은 폴더의 JSON 도 수집
        fq = urllib.parse.quote(f"'{fid}' in parents and trashed = false")
        jj = be._req("GET", f"{be.API}/files?q={fq}&fields=files(id,name,createdTime)&pageSize=1000")
        files = jj.get("files", [])
        by_base = {}
        for f in files:
            base = Path(f["name"]).stem
            by_base.setdefault(base, []).append(f)
        for base, group in by_base.items():
            created = min(dt.datetime.fromisoformat(f["createdTime"].replace("Z", "+00:00")) for f in group)
            if created >= cutoff:
                kept += len(group)
                continue
            for f in group:
                moved.append({"file": f"{fname}/{f['name']}", "age_days": round((now_local() - created).days, 1)})
                if not dry:
                    be._req("PATCH", f"{be.API}/files/{f['id']}", b'{"trashed": true}',
                            {"Content-Type": "application/json"})

    if purge_days is not None:
        # 드라이브는 이미 휴지통(30일 후 자동 삭제)이므로 추가 작업 없음
        log(" 드라이브 휴지통은 30일 뒤 자동 삭제됩니다(추가 조치 없음)")

    return {"moved": moved, "purged": purged, "kept": kept}


def main() -> None:
    ap = argparse.ArgumentParser(description="365일 지난 Hemory 녹음 정리")
    ap.add_argument("--days", type=int, default=None, help="보관 일수 (기본 365)")
    ap.add_argument("--purge-days", type=int, default=None,
                    help="_trash 에서 이 일수가 지나면 실제 삭제(기본 30, --purge 없으면 비활성)")
    ap.add_argument("--purge", action="store_true", help="_trash 정리도 수행")
    ap.add_argument("--backend", choices=["local", "drive"], default=None)
    ap.add_argument("--root", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--config", type=Path, default=None)
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.backend:
        cfg["backend"] = args.backend
    if args.root:
        cfg["local_root"] = args.root
    days = args.days or cfg.get("retention_days", 365)
    purge_days = (args.purge_days if args.purge_days is not None else 30) if args.purge else None

    ensure_dirs(cfg)
    be = make_backend(cfg)
    log(f"정리 시작 · 백엔드={be.kind} · 보관 {days}일 · dry_run={args.dry_run}")
    res = prune_local(be, cfg, days, args.dry_run, purge_days) if be.kind == "local" \
        else prune_drive(be, cfg, days, args.dry_run, purge_days)

    for m in res["moved"]:
        log(f"  {'[dry] ' if args.dry_run else ''}이동: {m['file']} ({m['age_days']}일)")
    for p in res["purged"]:
        log(f"  {'[dry] ' if args.dry_run else ''}삭제: {p}")
    log(f"이동 {len(res['moved'])}건 · 삭제 {len(res['purged'])}건 · 보존 {res['kept']}건")

    record = {"at": now_local().isoformat(timespec="seconds"), "backend": be.kind, "days": days,
              "moved": res["moved"], "purged": res["purged"], "kept": res["kept"], "dry_run": args.dry_run}
    if be.kind == "local":
        logdir = Path(cfg["local_root"]) / cfg["state"]
        logdir.mkdir(parents=True, exist_ok=True)
        with (logdir / "prune-log.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
