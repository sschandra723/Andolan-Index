"""Paths, JSON helpers and small functions shared by every command."""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("ANDOLAN_DATA") or ROOT / "data")
CONFIG = ROOT / "config"
SCHEMA = ROOT / "schema"

# A movement with a report in the last ACTIVE_DAYS days is "active"; older is "quiet".
# "ended" is only ever set by hand (the movement's `ended` date).
ACTIVE_DAYS = 21

REPORT_KEYS = ["id", "movement", "date", "outlet", "kind", "url", "archive_url", "summary", "read", "drafted_by", "added"]
_TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|ref$|ref_src$|igshid$|mc_|cmpid$|ocid$|taid$)", re.I)


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def parse_date(s: str) -> date:
    return date.fromisoformat(s)


def normalize_url(url: str) -> str:
    """Reduce a URL to a comparable key: no scheme, no www, no tracking params, no AMP marker, no trailing slash."""
    p = urlsplit(url.strip())
    host = p.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = re.sub(r"^/amp(?=/|$)", "", p.path)
    path = re.sub(r"(/amp|\.amp)$", "", path).rstrip("/") or "/"
    query = urlencode([(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not _TRACKING.match(k)])
    return f"{host}{path}" + (f"?{query}" if query else "")


def strip_tracking(url: str) -> str:
    """Remove tracking parameters and the #fragment but keep the real address (scheme, www, path) intact."""
    p = urlsplit(url.strip())
    query = urlencode([(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not _TRACKING.match(k)])
    return p._replace(query=query, fragment="").geturl()


def slugify(text: str, limit: int = 30) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit].strip("-") or "source"


def short_hash(text: str, n: int) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:n]


def report_id(report_date: str, outlet: str, url: str, movement: str) -> str:
    return f"{report_date}-{slugify(outlet)}-{short_hash(url + '|' + movement, 4)}"


def report_path(data: Path, rid: str) -> Path:
    return data / "reports" / rid[:4] / rid[5:7] / f"{rid}.json"


def ordered_report(r: dict) -> dict:
    return {k: r[k] for k in REPORT_KEYS if k in r}


def load_movements(data: Path = DATA) -> dict[str, dict]:
    return {m["id"]: m for m in (read_json(p) for p in sorted((data / "movements").glob("*.json")))}


def load_reports(data: Path = DATA) -> list[dict]:
    return [read_json(p) for p in sorted((data / "reports").glob("*/*/*.json"))]


def load_inbox(data: Path = DATA) -> list[dict]:
    return [read_json(p) for p in sorted((data / "inbox").glob("*.json"))]


def load_rejected(data: Path = DATA) -> set[str]:
    f = data / "rejected.txt"
    if not f.exists():
        return set()
    out = set()
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            out.add(normalize_url(line))
    return out


def status_for(movement: dict, latest: date | None, today: date, active_days: int = ACTIVE_DAYS) -> str:
    if movement.get("ended"):
        return "ended"
    if latest is not None and (today - latest).days <= active_days:
        return "active"
    return "quiet"


def month_or_day(s: str) -> tuple[int, int, int | None]:
    parts = s.split("-")
    return int(parts[0]), int(parts[1]), int(parts[2]) if len(parts) > 2 else None
