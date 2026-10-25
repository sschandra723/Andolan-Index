"""Which protest is most in the news right now, and which article leads it.

The front page leads with the movement that the most different outlets reported on in the past WINDOW_DAYS days.
Ties go to the movement with more reports in that window, then to the one reported most recently. Copies of an
agency story count once: "China Daily Asia (Bloomberg)" and "Bloomberg" are the same source.

Only journalism counts (news, opinion, explainers, fact-checks and roundups). Reference pages such as Wikipedia,
archive links and background pages are on the record but are not "coverage".

The lead article is the movement's newest report in the window. When several share that day, a full read beats a
headline-only summary, a news report beats commentary, and a report of detentions, injuries, deaths, shutdowns or
court orders beats one without.

If no movement has coverage in the window, the front page falls back to the most recently reported movement that
has not ended, and says so.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

WINDOW_DAYS = 7
COVERAGE_KINDS = {"news", "opinion", "explainer", "fact-check", "roundup"}
SIGNAL = re.compile(r"\b(detain|arrest|kill|dead|death|died|injur|lathi|tear gas|shut ?down|internet|curfew|"
                    r"section 163|section 144|supreme court|high court|hunger strike)", re.I)
_AGENCY = re.compile(r"\(([^()]+)\)\s*$")


def source_key(outlet: str) -> str:
    """'ThePrint (PTI)' -> 'pti'. A syndicated copy counts as its original source."""
    m = _AGENCY.search(outlet)
    return (m.group(1) if m else outlet).strip().casefold()


def _age(r: dict, today: date) -> int:
    return (today - date.fromisoformat(r["date"])).days


def _lead_article(reports: list[dict]) -> dict:
    newest = max(r["date"] for r in reports)
    same_day = [r for r in reports if r["date"] == newest]
    return max(same_day, key=lambda r: (bool(r.get("read")), r["kind"] == "news", bool(SIGNAL.search(r["summary"])), r["id"]))


def coverage(movements: list[dict], today: date, days: int = WINDOW_DAYS) -> dict:
    """Adds a 'coverage' block to each movement (with its reports attached) and returns the ranking.

    coverage = {outlets, reports, prev_outlets, prev_reports, daily: [counts for the last 2*days days, oldest first], rank}
    """
    ranked = []
    for m in movements:
        recent = [r for r in m["reports"] if r["kind"] in COVERAGE_KINDS and 0 <= _age(r, today) < 2 * days]
        week = [r for r in recent if _age(r, today) < days]
        prev = [r for r in recent if _age(r, today) >= days]
        daily = [0] * (2 * days)
        for r in recent:
            daily[2 * days - 1 - _age(r, today)] += 1
        m["coverage"] = {"outlets": len({source_key(r["outlet"]) for r in week}), "reports": len(week),
                         "prev_outlets": len({source_key(r["outlet"]) for r in prev}), "prev_reports": len(prev),
                         "daily": daily, "rank": None}
        if week:
            ranked.append((m, week))
    ranked.sort(key=lambda x: (x[0]["coverage"]["outlets"], x[0]["coverage"]["reports"], max(r["date"] for r in x[1]), x[0]["id"]),
                reverse=True)
    for i, (m, _) in enumerate(ranked):
        m["coverage"]["rank"] = i + 1
    window = {"days": days, "from": (today - timedelta(days=days - 1)).isoformat(), "to": today.isoformat()}
    if ranked:
        m, week = ranked[0]
        return {**window, "basis": "coverage", "lead": m["id"], "lead_report": _lead_article(week)["id"],
                "order": [x[0]["id"] for x in ranked]}
    fallback = [m for m in movements if m["reports"] and m["status"] != "ended"] or [m for m in movements if m["reports"]]
    if not fallback:
        return {**window, "basis": "none", "lead": None, "lead_report": None, "order": []}
    m = max(fallback, key=lambda m: (m["reports"][0]["date"], m["report_count"]))
    return {**window, "basis": "latest", "lead": m["id"], "lead_report": _lead_article(m["reports"])["id"], "order": []}
