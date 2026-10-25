"""Find new protest stories in RSS/Atom feeds and drop them in data/inbox/ for a person to review.

    python -m andolan collect                    # fetch every enabled feed
    python -m andolan collect --check-feeds      # only report which feeds respond
    python -m andolan collect --from-dir DIR     # read every *.xml file in DIR instead of the network (for tests)

The collector keeps the headline, link, outlet and date. It never stores article text or feed snippets;
a person writes the summary when promoting a candidate (see `curate`).
"""
from __future__ import annotations

import argparse
import html
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from defusedxml import ElementTree as ET

from .common import (CONFIG, DATA, load_inbox, load_movements, load_rejected, load_reports, normalize_url,
                     read_json, short_hash, strip_tracking, write_json)

USER_AGENT = "AndolanIndexBot/0.1 (public protest archive; contact via the repository issue tracker)"
MAX_BYTES = 5_000_000


# ---------- fetching and parsing ----------

def fetch(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (feed URLs come from our own config)
        data = resp.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("feed larger than 5 MB")
    return data


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _text(el) -> str:
    return "".join(el.itertext()).strip() if el is not None else ""


def clean_text(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def parse_pub_date(s: str | None) -> date | None:
    if not s:
        return None
    s = s.strip()
    try:
        return parsedate_to_datetime(s).astimezone(timezone.utc).date()
    except (TypeError, ValueError):
        pass
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).date() if dt.tzinfo else dt.date()
    except ValueError:
        return None


def parse_feed(xml: bytes) -> list[dict]:
    """Return [{title, link, published, snippet}] from an RSS 2.0 or Atom document."""
    root = ET.fromstring(xml)
    items = []
    for el in root.iter():
        name = _local(el.tag)
        if name not in ("item", "entry"):
            continue
        fields = {_local(c.tag): c for c in el}
        link = ""
        if name == "item":
            link = _text(fields.get("link"))
        else:
            for c in el:
                if _local(c.tag) == "link" and c.get("rel", "alternate") == "alternate" and c.get("href"):
                    link = c.get("href")
                    break
        published = parse_pub_date(_text(fields.get("pubDate")) or _text(fields.get("published")) or _text(fields.get("updated")) or _text(fields.get("date")))
        snippet = clean_text(_text(fields.get("description")) or _text(fields.get("summary")))
        title = clean_text(_text(fields.get("title")))
        if title and link.startswith(("http://", "https://")):
            items.append({"title": title, "link": link.strip(), "published": published, "snippet": snippet})
    return items


# ---------- matching ----------

def term_regex(terms: list[str]) -> re.Pattern:
    """One regex for a list of terms. See config/terms.json for the matching rules."""
    parts = []
    for t in terms:
        if t.startswith("="):
            parts.append("(?-i:(?<![A-Za-z0-9])" + re.escape(t[1:]) + "(?![A-Za-z0-9]))")
        elif t.isascii():
            parts.append("(?i:(?<![A-Za-z0-9])" + re.escape(t) + ")")
        else:
            parts.append(re.escape(t))
    return re.compile("|".join(parts) if parts else r"(?!)")


def find_terms(text: str, terms: list[str]) -> list[str]:
    """Which of `terms` occur in `text` (the = prefix is kept in the returned labels)."""
    hits = []
    for t in terms:
        if term_regex([t]).search(text):
            hits.append(t)
    return hits


def score_movements(text: str, movements: dict[str, dict]) -> dict[str, tuple[float, list[str]]]:
    """Score every movement for a piece of text. A keyword hit is worth 1, an alias hit is worth 2."""
    out = {}
    for mid, m in movements.items():
        alias_hits = find_terms(text, m.get("aliases", []))
        kw_hits = [k for k in find_terms(text, m["keywords"]) if k not in alias_hits]
        score = 2 * len(alias_hits) + len(kw_hits)
        if score:
            out[mid] = (float(score), alias_hits + kw_hits)
    return out


def classify(item: dict, feed: dict, terms: dict, movements: dict[str, dict]) -> dict | None:
    """Decide whether a feed item is a protest story and which movement it probably belongs to."""
    text = f"{item['title']} {item['snippet']}"
    if not find_terms(text, terms["protest_terms"]):
        return None
    if feed.get("require_india") and not find_terms(text, terms["india_terms"]):
        return None
    scores = score_movements(text, movements)
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1][0], kv[0]))
    best_id, (best_score, matched) = ranked[0] if ranked else (None, (0.0, []))
    suggested = best_id if best_score >= terms.get("min_score", 2) else None
    return {
        "suggested_movement": suggested,
        "score": best_score if ranked else 0,
        "matched": matched if ranked else [],
        "alternatives": [mid for mid, _ in ranked if mid != best_id],
    }


# ---------- orchestration ----------

def collect(feed_docs: list[tuple[dict, bytes]], data: Path = DATA, today: date | None = None,
            terms: dict | None = None) -> list[dict]:
    today = today or date.today()
    terms = terms or read_json(CONFIG / "terms.json")
    movements = load_movements(data)
    known = {normalize_url(r["url"]) for r in load_reports(data)}
    known |= {normalize_url(c["url"]) for c in load_inbox(data)}
    known |= load_rejected(data)
    cutoff = today - timedelta(days=terms.get("max_age_days", 7))
    new: list[dict] = []
    for feed, xml in feed_docs:
        for item in parse_feed(xml):
            key = normalize_url(item["link"])
            if key in known:
                continue
            if item["published"] and item["published"] < cutoff:
                continue
            verdict = classify(item, feed, terms, movements)
            if verdict is None:
                continue
            known.add(key)
            cand = {
                "id": short_hash(key, 10),
                "url": strip_tracking(item["link"]),
                "title": item["title"][:300],
                "outlet": feed["name"],
                "published": item["published"].isoformat() if item["published"] else None,
                "collected": today.isoformat(),
                **verdict,
            }
            write_json(data / "inbox" / f"{cand['id']}.json", cand)
            new.append(cand)
    return new


def summary_markdown(new: list[dict], movements: dict[str, dict]) -> str:
    if not new:
        return "No new protest stories found.\n"
    lines = [f"## {len(new)} new candidate(s)", "",
             "Open each link, read the article, then run `python -m andolan curate promote <id> --movement <movement> --summary \"...\"` "
             "or `python -m andolan curate reject <id>`.", ""]
    groups: dict[str | None, list[dict]] = {}
    for c in new:
        groups.setdefault(c["suggested_movement"], []).append(c)
    for mid in sorted(groups, key=lambda k: (k is None, k or "")):
        title = movements[mid]["name"] if mid else "Unsorted (no movement matched)"
        lines += [f"### {title}", ""]
        for c in sorted(groups[mid], key=lambda c: c["published"] or "", reverse=True):
            alt = f" (also maybe: {', '.join(c['alternatives'])})" if c["alternatives"] else ""
            lines.append(f"- `{c['id']}` [{c['title']}]({c['url']}): {c['outlet']}, {c['published'] or 'no date'}{alt}")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="andolan collect")
    ap.add_argument("--check-feeds", action="store_true", help="only test that each feed responds and parses")
    ap.add_argument("--from-dir", type=Path, help="read every *.xml file in this folder instead of fetching")
    ap.add_argument("--summary-file", type=Path, help="write a Markdown summary (used as the pull-request body)")
    ap.add_argument("--today", type=date.fromisoformat, default=None)
    args = ap.parse_args(argv)

    docs: list[tuple[dict, bytes]] = []
    failed = 0
    if args.from_dir:  # offline mode: every *.xml file is a feed, named after the file
        feeds = [{"name": p.stem, "require_india": False, "_file": p} for p in sorted(args.from_dir.glob("*.xml"))]
    else:
        feeds = [f for f in read_json(CONFIG / "feeds.json")["feeds"] if f.get("enabled", True)]
    for feed in feeds:
        try:
            xml = feed["_file"].read_bytes() if "_file" in feed else fetch(feed["url"])
            n = len(parse_feed(xml))
            print(f"{'ok  ' if n else 'warn'} {feed['name']}: {n} items" + ("" if n else " (parsed but empty)"))
            docs.append((feed, xml))
        except Exception as e:  # one broken feed must not stop the others
            failed += 1
            print(f"FAIL {feed['name']}: {type(e).__name__}: {e}", file=sys.stderr)
    if args.check_feeds:
        return 1 if failed else 0
    if not docs:
        print("No feed could be read; nothing collected.", file=sys.stderr)
        return 1
    new = collect(docs, today=args.today)
    print(f"\n{len(new)} new candidate(s) written to data/inbox/")
    if args.summary_file:
        args.summary_file.write_text(summary_markdown(new, load_movements()), encoding="utf-8")
    return 0
