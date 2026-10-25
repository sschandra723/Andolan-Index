"""Build the static website and the public data downloads into ./site.

    python -m andolan build                  # uses today's date to decide Active / Quiet
    python -m andolan build --today 2026-10-25 --out /tmp/site

The site is one page (index.html) that renders every view from the dataset embedded in it, plus a permanent
page per movement (m/<id>.html) that opens that movement in the app, or lists its reports when JavaScript is off.
It needs no server, so it can be hosted anywhere (GitHub Pages, Netlify, S3).
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import os
import shutil
from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from .coverage import coverage
from .common import (ACTIVE_DAYS, CONFIG, DATA, ROOT, load_inbox, load_movements, load_reports, month_or_day, read_json,
                     status_for, write_json)

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
STATUS_ORDER = {"active": 0, "quiet": 1, "ended": 2}
STATUS_LABEL = {"active": "Active", "quiet": "Quiet", "ended": "Ended"}
FONTS = ("https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800;900"
         "&family=Big+Shoulders+Text:wght@500;600;700&family=Mukta:wght@400;500;600;700&family=Rozha+One&display=swap")

e = html.escape


def fmt(s: str | None) -> str:
    if not s:
        return ""
    y, m, d = month_or_day(s)
    return f"{d} {MONTHS[m - 1]} {y}" if d else f"{MONTHS[m - 1]} {y}"


def load_site_config() -> dict:
    cfg = {"title": "Andolan Index", "tagline": "", "base_url": "", "repo_url": "", "active_days": ACTIVE_DAYS}
    cfg.update(read_json(CONFIG / "site.json"))
    cfg["base_url"] = (os.environ.get("ANDOLAN_BASE_URL") or cfg["base_url"]).rstrip("/")
    return cfg


def assemble(data: Path, today: date, active_days: int) -> list[dict]:
    """Movements with their reports attached and Active / Quiet / Ended worked out."""
    movements = load_movements(data)
    by_movement: dict[str, list[dict]] = {mid: [] for mid in movements}
    for r in load_reports(data):
        if r["movement"] in by_movement:
            by_movement[r["movement"]].append(r)
    out = []
    for mid, m in movements.items():
        reps = sorted(by_movement[mid], key=lambda r: (r["date"], r["id"]), reverse=True)
        latest = date.fromisoformat(reps[0]["date"]) if reps else None
        out.append({**m, "status": status_for(m, latest, today, active_days), "latest_report": reps[0]["date"] if reps else None,
                    "report_count": len(reps), "reports": reps})
    out.sort(key=lambda m: (STATUS_ORDER[m["status"]], [-ord(c) for c in (m["latest_report"] or "")]))
    return out


# ---------- HTML ----------

def embed_json(obj) -> str:
    """JSON that is safe inside <script type="application/json">: no '<', '>' or '&' can close the tag."""
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))


def waiting_for_review(data: Path, movements: list[dict]) -> list[dict]:
    """Headlines and links of inbox stories, for the 'Waiting for review' strip. Only used when autonomy is 'links'.
    AI-written text is deliberately left out: nothing the model wrote is shown until an editor approves it."""
    from .ai import load_config
    if load_config().get("autonomy") != "links":
        return []
    known = {m["id"] for m in movements}
    out = []
    for c in load_inbox(data):
        ai = c.get("ai") or {}
        if ai and (not ai.get("is_protest_in_india") or ai.get("movement") == "none"):
            continue
        guess = ai.get("movement") if ai.get("movement") in known else c.get("suggested_movement")
        out.append({"title": c["title"], "outlet": c["outlet"], "url": c["url"], "published": c.get("published"),
                    "movement": guess if guess in known else None, "importance": ai.get("importance")})
    out.sort(key=lambda x: (x["importance"] or 0, x["published"] or ""), reverse=True)
    return out[:8]


def client_data(cfg: dict, movements: list[dict], directory: list[dict], today: date, waiting: list[dict] | None = None) -> dict:
    keep = ["id", "name", "short_name", "aliases", "cause", "states", "places", "locations", "started", "ended", "about",
            "demands", "context", "status", "latest_report", "report_count", "reports"]
    client = [{k: m[k] for k in keep if k in m} for m in movements]
    return {
        "today": today.isoformat(),
        "config": {k: cfg[k] for k in ("title", "tagline", "base_url", "repo_url", "active_days")},
        "movements": client,
        "lead": coverage(client, today),
        "directory": directory,
        "map": read_json(ROOT / "site_src" / "india-map.json"),
        "waiting": waiting or [],
        "ai": _ai_public(),
    }


def _ai_public() -> dict:
    from .ai import load_config
    c = load_config()
    model = c["ollama"]["model"] if c["provider"] == "ollama" else c["anthropic"]["model"] if c["provider"] == "anthropic" else None
    return {"provider": c["provider"], "model": model, "autonomy": c["autonomy"]}


def noscript_list(movements: list[dict], root: str) -> str:
    items = "".join(f'<li><a href="{root}m/{m["id"]}.html">{e(m["name"])}</a>: {STATUS_LABEL[m["status"]].lower()}, '
                    f'{m["report_count"]} report{"s" if m["report_count"] != 1 else ""}.</li>' for m in movements)
    return f'<div style="max-width:70ch;margin:2rem auto;padding:0 16px;font-family:system-ui,sans-serif"><h1>Andolan Index</h1><ul>{items}</ul></div>'


def head_extra(cfg: dict, path: str, title: str, desc: str) -> str:
    base = cfg["base_url"]
    if not base:
        return ""
    url = f"{base}/{path}"
    return (f'<link rel="canonical" href="{e(url)}"><meta property="og:title" content="{e(title)}">'
            f'<meta property="og:description" content="{e(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="{e(url)}">')


def render_index(cfg: dict, movements: list[dict], directory: list[dict], today: date, waiting: list[dict] | None = None) -> str:
    template = (ROOT / "site_src" / "index.html").read_text(encoding="utf-8")
    fill = {
        "title": e(cfg["title"]), "description": e(cfg["tagline"]), "root": "", "fonts": e(FONTS),
        "head_extra": head_extra(cfg, "", cfg["title"], cfg["tagline"]),
        "noscript": noscript_list(movements, ""),
        "data": embed_json(client_data(cfg, movements, directory, today, waiting)),
    }
    for k, v in fill.items():
        template = template.replace("{{" + k + "}}", v)
    return template


def permalink_page(cfg: dict, m: dict) -> str:
    """A stable URL for each movement. With JavaScript it opens the movement inside the app; without, it lists the reports."""
    reps = "".join(f'<li><b>{fmt(r["date"])}</b>, <a href="{e(r["url"])}">{e(r["outlet"])}</a>{"" if r["read"] else " (headline only)"}: {e(r["summary"])}</li>'
                   for r in m["reports"])
    title = f'{m["name"]} | {cfg["title"]}'
    dates = f'Began {fmt(m["started"])}' + (f', ended {fmt(m["ended"])}' if m.get("ended") else "")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title><meta name="description" content="{e(m["about"][:200])}">{head_extra(cfg, f'm/{m["id"]}.html', title, m["about"][:200])}
<script>location.replace("../index.html#{m["id"]}");</script></head>
<body style="max-width:70ch;margin:2rem auto;padding:0 16px;font-family:system-ui,sans-serif;line-height:1.5">
<p><a href="../index.html">Andolan Index</a></p><h1>{e(m["name"])}</h1>
<p>{STATUS_LABEL[m["status"]]}. {e(m["places"])}. {dates}.</p><p>{e(m["about"])}</p><p><b>Demands:</b> {e(m["demands"])}</p>
<h2>Reports</h2><ul>{reps}</ul>{background_html(m)}</body></html>"""


def background_html(m: dict) -> str:
    c = m.get("context")
    if not c:
        return ""
    paras = "".join(f"<p>{e(x)}</p>" for x in c["explainer"])
    impact = "".join(f"<li>{e(x)}</li>" for x in c["impact"])
    srcs = "".join(f'<li><a href="{e(x["url"])}">{e(x["title"])}</a></li>' for x in c["sources"])
    return (f'<h2>Background: {e(c["question"])}</h2><p>{e(c["short"])}</p>{paras}'
            f'<h3>What it changes</h3><ul>{impact}</ul><h3>Sources</h3><ol>{srcs}</ol>')


def about_redirect() -> str:
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How this works | Andolan Index</title>'
            '<script>location.replace("index.html#about");</script></head><body><p><a href="index.html#about">How this works</a></p></body></html>')


def atom_feed(cfg: dict, movements: list[dict], today: date) -> str:
    names = {m["id"]: m["name"] for m in movements}
    reports = sorted((r for m in movements for r in m["reports"]), key=lambda r: (r["date"], r["id"]), reverse=True)[:50]
    base = cfg["base_url"]
    entries = "".join(
        f'<entry><id>tag:andolan-index,{r["date"]}:{xml_escape(r["id"])}</id><title>{xml_escape(names[r["movement"]])}: {xml_escape(r["outlet"])}</title>'
        f'<link href="{xml_escape(r["url"])}"/><updated>{r["date"]}T00:00:00Z</updated><category term="{xml_escape(names[r["movement"]])}"/>'
        f'<summary>{xml_escape(r["summary"])}</summary></entry>' for r in reports)
    self_link = f'<link rel="self" href="{xml_escape(base)}/feed.xml"/><link href="{xml_escape(base)}/"/>' if base else ""
    updated = (reports[0]["date"] if reports else today.isoformat()) + "T00:00:00Z"
    return (f'<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>tag:andolan-index,2026:feed</id>'
            f'<title>{xml_escape(cfg["title"])}: newest reports</title><updated>{updated}</updated>{self_link}{entries}</feed>')


def sitemap(cfg: dict, movements: list[dict]) -> str:
    urls = ["", "about.html"] + [f"m/{m['id']}.html" for m in movements]
    return ('<?xml version="1.0" encoding="utf-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            + "".join(f'<url><loc>{xml_escape(cfg["base_url"] + "/" + u)}</loc></url>' for u in urls) + "</urlset>")


def build(*, out: Path, today: date, data: Path = DATA) -> dict:
    cfg = load_site_config()
    movements = assemble(data, today, cfg["active_days"])
    directory = read_json(data / "directory.json") if (data / "directory.json").exists() else []
    if out.exists():
        shutil.rmtree(out)
    (out / "assets").mkdir(parents=True)
    for name in ("style.css", "app.js"):
        shutil.copy(ROOT / "site_src" / name, out / "assets" / name)
    (out / "index.html").write_text(render_index(cfg, movements, directory, today, waiting_for_review(data, movements)), encoding="utf-8")
    (out / "about.html").write_text(about_redirect(), encoding="utf-8")
    (out / "m").mkdir()
    for m in movements:
        (out / "m" / f'{m["id"]}.html').write_text(permalink_page(cfg, m), encoding="utf-8")
        write_json(out / "data" / "m" / f'{m["id"]}.json', m)
    write_json(out / "data" / "movements.json", movements)
    names = {m["id"]: m["name"] for m in movements}
    flat = [{**r, "movement_name": names[r["movement"]]} for m in movements for r in m["reports"]]
    flat.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
    write_json(out / "data" / "reports.json", flat)
    cols = ["id", "movement", "movement_name", "date", "outlet", "kind", "url", "archive_url", "summary", "read", "added"]
    with (out / "data" / "reports.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(flat)
    (out / "feed.xml").write_text(atom_feed(cfg, movements, today), encoding="utf-8")
    if cfg["base_url"]:
        (out / "sitemap.xml").write_text(sitemap(cfg, movements), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    return {"movements": len(movements), "reports": len(flat), "active": sum(m["status"] == "active" for m in movements)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="andolan build")
    ap.add_argument("--out", type=Path, default=ROOT / "site")
    ap.add_argument("--today", type=date.fromisoformat, default=None)
    args = ap.parse_args(argv)
    stats = build(out=args.out, today=args.today or date.today())
    print(f"Built {stats['movements']} movements ({stats['active']} active), {stats['reports']} reports -> {args.out}")
    return 0
