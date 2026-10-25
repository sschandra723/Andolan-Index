"""Find or request a Wayback Machine copy for reports that have no archive_url, so links survive link rot.

    python -m andolan archive --limit 20            # look up existing snapshots only
    python -m andolan archive --limit 20 --save     # also ask the Wayback Machine to capture pages it lacks

Be polite: the default is a small batch with a pause between requests.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .common import DATA, read_json, write_json

AVAILABLE = "https://archive.org/wayback/available?url="
SAVE = "https://web.archive.org/save/"
UA = {"User-Agent": "AndolanIndexBot/0.1 (public protest archive)"}


def _open(url: str, timeout: int = 40):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)  # noqa: S310


def find_snapshot(url: str, opener=_open) -> str | None:
    """Closest existing snapshot URL, or None."""
    with opener(AVAILABLE + urllib.parse.quote(url, safe="")) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    snap = (body.get("archived_snapshots") or {}).get("closest")
    if snap and snap.get("available") and str(snap.get("url", "")).startswith("http"):
        return snap["url"].replace("http://", "https://", 1)
    return None


def request_save(url: str, opener=_open) -> str | None:
    """Ask the Wayback Machine to capture `url`. Returns the snapshot path it reports, if any."""
    with opener(SAVE + url) as resp:
        loc = resp.headers.get("Content-Location") or ""
    return "https://web.archive.org" + loc if loc.startswith("/web/") else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="andolan archive")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--pause", type=float, default=5.0)
    args = ap.parse_args(argv)
    done = 0
    for path in sorted(Path(DATA / "reports").glob("*/*/*.json"), reverse=True):
        if done >= args.limit:
            break
        r = read_json(path)
        if r.get("archive_url"):
            continue
        try:
            snap = find_snapshot(r["url"]) or (request_save(r["url"]) if args.save else None)
        except Exception as e:  # network trouble must not abort the batch
            print(f"skip {r['id']}: {type(e).__name__}: {e}")
            snap = None
        done += 1
        if snap:
            r["archive_url"] = snap
            write_json(path, r)
            print(f"archived {r['id']} -> {snap}")
        time.sleep(args.pause)
    return 0
