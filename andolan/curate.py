"""Turn inbox candidates into reports, or reject them. Also add articles found by hand.

    python -m andolan curate list
    python -m andolan curate promote <id> [--movement <movement-id>] [--summary "..."] [--read] [--kind news]
        (without --summary, uses the AI draft if it passed its checks; without --movement, the AI's or collector's guess)
    python -m andolan curate accept-ai [--min-score 0]     # approve every AI draft that passed its checks
    python -m andolan curate reject <id> [--reason "not about a protest"]
    python -m andolan curate add --url URL --outlet NAME --date YYYY-MM-DD --movement ID --summary "..." [--read]
    python -m andolan curate new-movement <id> [--from <candidate-id>]   # stub to fill in; --from pre-fills the AI's proposal
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from jsonschema import Draft202012Validator

from .common import (DATA, SCHEMA, load_inbox, load_movements, load_reports, normalize_url, ordered_report,
                     read_json, report_id, report_path, write_json)  # noqa: F401

KINDS = ["news", "explainer", "opinion", "reference", "fact-check", "archive", "background", "roundup"]


class CurateError(Exception):
    pass


def add_report(*, url: str, outlet: str, report_date: str, movement: str, summary: str, read: bool, kind: str = "news",
               data: Path = DATA, today: date | None = None, drafted_by: str = "person") -> Path:
    """Validate and write one report. Raises CurateError with a plain-language message."""
    today = today or date.today()
    if movement not in load_movements(data):
        raise CurateError(f"Unknown movement '{movement}'. Existing: {', '.join(sorted(load_movements(data)))}")
    key = (movement, normalize_url(url))
    if any((r["movement"], normalize_url(r["url"])) == key for r in load_reports(data)):
        raise CurateError(f"That article is already filed under '{movement}'.")
    report = ordered_report({
        "id": report_id(report_date, outlet, url, movement), "movement": movement, "date": report_date,
        "outlet": outlet, "kind": kind, "url": url, "archive_url": None, "summary": summary.strip(),
        "read": read, "drafted_by": drafted_by, "added": today.isoformat(),
    })
    errors = [f"{'/'.join(map(str, e.absolute_path))}: {e.message}"
              for e in Draft202012Validator(read_json(SCHEMA / "report.schema.json")).iter_errors(report)]
    if errors:
        raise CurateError("The report is not valid:\n  - " + "\n  - ".join(errors))
    path = report_path(data, report["id"])
    write_json(path, report)
    return path


def promote(cid: str, *, movement: str | None = None, summary: str | None = None, read: bool = False, kind: str = "news",
            report_date: str | None = None, data: Path = DATA, today: date | None = None,
            accept_unchecked: bool = False) -> Path:
    f = data / "inbox" / f"{cid}.json"
    if not f.exists():
        raise CurateError(f"No inbox candidate '{cid}'. Run `python -m andolan curate list`.")
    c = read_json(f)
    ai = c.get("ai") or {}
    movements = load_movements(data)
    if movement is None:
        movement = ai.get("movement") if ai.get("movement") in movements else c.get("suggested_movement")
        if not movement:
            raise CurateError("No movement guessed for this story; pass --movement <id>.")
    drafted_by = "person"
    if summary is None:
        if not ai.get("summary"):
            raise CurateError("There is no AI draft for this story; pass --summary \"...\".")
        if not ai.get("checks", {}).get("passed") and not accept_unchecked:
            raise CurateError("The AI draft did not pass its checks:\n  - " + "\n  - ".join(ai.get("checks", {}).get("problems", []))
                              + "\nWrite your own with --summary, or pass --accept-unchecked after reading the article.")
        summary, drafted_by = ai["summary"], "ai"
        read = read or ai.get("read_chars", 0) > 300
    d = report_date or c["published"]
    if not d:
        raise CurateError("This candidate has no publication date; pass --date YYYY-MM-DD.")
    path = add_report(url=c["url"], outlet=c["outlet"], report_date=d, movement=movement, summary=summary, read=read,
                      kind=kind, data=data, today=today, drafted_by=drafted_by)
    f.unlink()
    return path


def accept_ai(*, min_score: int = 0, min_confidence: float = 0.6, data: Path = DATA, today: date | None = None) -> list[Path]:
    """Approve every AI draft that passed its checks, is about a movement we already track, and is confident enough.
    Run it only after skimming the drafts in the pull request."""
    movements = load_movements(data)
    written = []
    for c in load_inbox(data):
        ai = c.get("ai") or {}
        if (ai.get("checks", {}).get("passed") and ai.get("is_protest_in_india") and ai.get("movement") in movements
                and ai.get("importance", 0) >= min_score and ai.get("confidence", 0) >= min_confidence and c.get("published")):
            try:
                written.append(promote(c["id"], data=data, today=today))
            except CurateError as e:
                print(f"skip {c['id']}: {e}", file=sys.stderr)
    return written


def reject(cid: str, reason: str = "", data: Path = DATA) -> None:
    f = data / "inbox" / f"{cid}.json"
    if not f.exists():
        raise CurateError(f"No inbox candidate '{cid}'.")
    c = read_json(f)
    line = c["url"] + (f"   # {reason}" if reason else "") + "\n"
    with (data / "rejected.txt").open("a", encoding="utf-8") as fh:
        fh.write(line)
    f.unlink()


def new_movement(mid: str, data: Path = DATA, from_candidate: str | None = None) -> Path:
    path = data / "movements" / f"{mid}.json"
    if path.exists():
        raise CurateError(f"{path.name} already exists.")
    stub = {
        "id": mid, "name": "TODO name", "aliases": [], "keywords": ["TODO"], "cause": "Other", "states": ["Delhi"],
        "places": "TODO", "started": date.today().isoformat(),
        "about": "TODO: what the protest is about, who is leading it and how the authorities responded. Attribute contested claims.",
        "demands": "TODO",
    }
    if from_candidate:
        c = read_json(data / "inbox" / f"{from_candidate}.json")
        prop = (c.get("ai") or {}).get("new_movement") or {}
        for k in ("name", "short_name", "places"):
            if prop.get(k):
                stub[k] = prop[k]
        if prop.get("states"):
            stub["states"] = prop["states"]
        if prop.get("cause") in ("Elections", "Labour", "Exams", "Agriculture", "Autonomy", "Environment", "Rights", "Land", "Other"):
            stub["cause"] = prop["cause"]
        if c.get("published"):
            stub["started"] = c["published"]
        stub["about"] = "TODO check and expand: " + ((c.get("ai") or {}).get("summary") or "")
    write_json(path, stub)
    return path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="andolan curate")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p = sub.add_parser("promote"); p.add_argument("id"); p.add_argument("--movement")
    p.add_argument("--summary"); p.add_argument("--read", action="store_true", help="you read the full article")
    p.add_argument("--kind", choices=KINDS, default="news"); p.add_argument("--date")
    p.add_argument("--accept-unchecked", action="store_true", help="use an AI draft that failed its checks (read the article first)")
    x = sub.add_parser("accept-ai"); x.add_argument("--min-score", type=int, default=0)
    r = sub.add_parser("reject"); r.add_argument("id"); r.add_argument("--reason", default="")
    a = sub.add_parser("add"); a.add_argument("--url", required=True); a.add_argument("--outlet", required=True)
    a.add_argument("--date", required=True); a.add_argument("--movement", required=True); a.add_argument("--summary", required=True)
    a.add_argument("--read", action="store_true"); a.add_argument("--kind", choices=KINDS, default="news")
    n = sub.add_parser("new-movement"); n.add_argument("id"); n.add_argument("--from", dest="from_candidate")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "list":
            inbox = sorted(load_inbox(), key=lambda c: (-((c.get("ai") or {}).get("importance") or 0), c["published"] or ""))
            for c in inbox:
                ai = c.get("ai") or {}
                guess = ai.get("movement") or c["suggested_movement"] or "unsorted"
                state = ("score %3d, %s" % (ai["importance"], "checks passed" if ai["checks"]["passed"] else "needs checking")) if ai else "no AI draft"
                print(f"{c['id']}  {c['published'] or '----------'}  [{guess}]  {c['outlet']}: {c['title']}\n            {state}\n            {c['url']}")
                if ai.get("summary"):
                    print(f"            draft: {ai['summary']}")
            print(f"\n{len(inbox)} candidate(s)")
        elif args.cmd == "promote":
            print("wrote", promote(args.id, movement=args.movement, summary=args.summary, read=args.read, kind=args.kind,
                                   report_date=args.date, accept_unchecked=args.accept_unchecked))
        elif args.cmd == "accept-ai":
            done = accept_ai(min_score=args.min_score)
            print(f"approved {len(done)} AI draft(s)")
        elif args.cmd == "reject":
            reject(args.id, args.reason); print("rejected", args.id)
        elif args.cmd == "add":
            print("wrote", add_report(url=args.url, outlet=args.outlet, report_date=args.date, movement=args.movement,
                                      summary=args.summary, read=args.read, kind=args.kind))
        elif args.cmd == "new-movement":
            print("wrote", new_movement(args.id, from_candidate=args.from_candidate), "\nFill in every TODO, then add a first report with `curate add` or `curate promote`.")
    except CurateError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0
