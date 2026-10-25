"""Check every data file against its schema and against the rest of the dataset.

    python -m andolan validate            # exit code 1 if anything is wrong
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

from jsonschema import Draft202012Validator

from .common import (DATA, SCHEMA, load_rejected, normalize_url, read_json, report_id)


def _validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(read_json(SCHEMA / name))


def _schema_errors(validator: Draft202012Validator, obj, label: str) -> list[str]:
    return [f"{label}: {'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}" for e in validator.iter_errors(obj)]


def check_dataset(data: Path = DATA, today: date | None = None) -> list[str]:
    today = today or date.today()
    errors: list[str] = []
    v_move, v_rep, v_cand, v_dir = (_validator(n) for n in
        ("movement.schema.json", "report.schema.json", "candidate.schema.json", "directory.schema.json"))

    def load(path: Path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            errors.append(f"{path.relative_to(data)}: cannot read JSON ({e})")
            return None

    # movements
    movements: dict[str, dict] = {}
    for p in sorted((data / "movements").glob("*.json")):
        m = load(p)
        if m is None:
            continue
        label = f"movements/{p.name}"
        errors += _schema_errors(v_move, m, label)
        if isinstance(m, dict) and m.get("id"):
            if p.stem != m["id"]:
                errors.append(f"{label}: file name must match id '{m['id']}'")
            if m["id"] in movements:
                errors.append(f"{label}: duplicate movement id")
            movements[m["id"]] = m
            if "TODO" in json.dumps(m):
                errors.append(f"{label}: still contains TODO placeholders")
            if m.get("ended") and m.get("started") and m["ended"] < m["started"][:10].ljust(10, "0"):
                errors.append(f"{label}: ended is before started")

    # reports
    seen_pairs: dict[tuple[str, str], str] = {}
    per_movement: dict[str, int] = {mid: 0 for mid in movements}
    for p in sorted((data / "reports").glob("*/*/*.json")):
        r = load(p)
        if r is None:
            continue
        label = f"reports/{p.relative_to(data / 'reports')}"
        errs = _schema_errors(v_rep, r, label)
        errors += errs
        if errs or not isinstance(r, dict):
            continue
        if p.stem != r["id"] or p.parent.parent.name != r["date"][:4] or p.parent.name != r["date"][5:7]:
            errors.append(f"{label}: file name/folder must be reports/<yyyy>/<mm>/{r['id']}.json matching the date")
        if r["id"] != report_id(r["date"], r["outlet"], r["url"], r["movement"]):
            errors.append(f"{label}: id does not match date/outlet/url/movement (expected {report_id(r['date'], r['outlet'], r['url'], r['movement'])})")
        if r["movement"] not in movements:
            errors.append(f"{label}: unknown movement '{r['movement']}'")
        else:
            per_movement[r["movement"]] += 1
        if date.fromisoformat(r["date"]) > today + timedelta(days=1):
            errors.append(f"{label}: date {r['date']} is in the future")
        key = (r["movement"], normalize_url(r["url"]))
        if key in seen_pairs:
            errors.append(f"{label}: same article already filed under '{r['movement']}' ({seen_pairs[key]})")
        seen_pairs[key] = p.name

    for mid, n in per_movement.items():
        if n == 0:
            errors.append(f"movements/{mid}.json: no reports yet; every movement needs at least one")

    # inbox
    report_urls = {normalize_url(u) for (_, u) in seen_pairs}
    rejected = load_rejected(data)
    for p in sorted((data / "inbox").glob("*.json")):
        c = load(p)
        if c is None:
            continue
        label = f"inbox/{p.name}"
        errs = _schema_errors(v_cand, c, label)
        errors += errs
        if errs or not isinstance(c, dict):
            continue
        if p.stem != c["id"]:
            errors.append(f"{label}: file name must match id")
        if c["suggested_movement"] and c["suggested_movement"] not in movements:
            errors.append(f"{label}: suggested_movement '{c['suggested_movement']}' does not exist")
        ai_mv = (c.get("ai") or {}).get("movement")
        if ai_mv and ai_mv not in movements and ai_mv not in ("new", "none"):
            errors.append(f"{label}: AI movement '{ai_mv}' does not exist")
        if normalize_url(c["url"]) in rejected:
            errors.append(f"{label}: URL is on the rejected list")

    # directory
    d = data / "directory.json"
    if d.exists():
        obj = load(d)
        if obj is not None:
            errors += _schema_errors(v_dir, obj, "directory.json")
    return errors


def main(argv: list[str] | None = None) -> int:
    errors = check_dataset()
    if errors:
        print(f"{len(errors)} problem(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    movements = len(list((DATA / "movements").glob("*.json")))
    reports = len(list((DATA / "reports").glob("*/*/*.json")))
    inbox = len(list((DATA / "inbox").glob("*.json")))
    print(f"OK: {movements} movements, {reports} reports, {inbox} in inbox")
    return 0
