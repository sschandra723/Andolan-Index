import json
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

from andolan import archive, build, collect, curate, validate
from andolan.common import DATA, load_reports, normalize_url, read_json, status_for

FIX = Path(__file__).parent / "fixtures"
TODAY = date(2026, 10, 25)
CHECK_DAY = date(2026, 11, 8)  # validate the real dataset as of its newest report, so later reports are not "in the future"
FEEDS = [({"name": "Sample India Desk", "require_india": False}, (FIX / "rss_sample.xml").read_bytes()),
         ({"name": "Sample Atom Desk", "require_india": True}, (FIX / "atom_sample.xml").read_bytes())]
# A news search feed in Bing's format: links go through a Bing redirect, and each item names its outlet.
BING = b"""<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:News="https://www.bing.com/news/search?q=protest&amp;format=rss" version="2.0"><channel><title>protest India - BingNews</title>
<item><title>Farmers protest outside the secretariat in Kohima</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc&amp;url=https%3a%2f%2fwww.example-news.test%2fnortheast%2ffarmers-protest-kohima%3futm_source%3drss&amp;c=123&amp;mkt=en-in</link>
<description>Farmers held a protest in Kohima on Monday.</description><pubDate>Mon, 09 Nov 2026 06:00:00 GMT</pubDate>
<News:Source>Example News</News:Source></item>
<item><title>Students protest a fee hike in Delhi</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fwww.other-paper.test%2fstudents-fee-protest</link>
<description>Students protest.</description><pubDate>Mon, 09 Nov 2026 07:00:00 GMT</pubDate></item>
<item><title>Nurses protest unpaid wages</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fwww.msn.com%2fen-in%2fnews%2findia%2fnurses-protest%2far-AA1x</link>
<description>Nurses protest.</description><pubDate>Mon, 09 Nov 2026 08:00:00 GMT</pubDate><News:Source>Example News on MSN</News:Source></item>
</channel></rss>"""


class Tmp(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.data = self.dir / "data"
        shutil.copytree(DATA, self.data)
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)


class TestHelpers(unittest.TestCase):
    def test_normalize_url(self):
        a = normalize_url("https://www.Example.com/news/story/?utm_source=x&id=5#frag")
        self.assertEqual(a, "example.com/news/story?id=5")
        self.assertEqual(normalize_url("https://www.business-standard.com/amp/india-news/x_1.html"),
                         normalize_url("https://business-standard.com/india-news/x_1.html"))

    def test_terms(self):
        hits = collect.find_terms("Protesters demand Gyanesh Kumar quit over SIR as sirens wail", ["protest", "=SIR", "=sir", "sir", "Gyanesh Kumar"])
        self.assertEqual(hits, ["protest", "=SIR", "sir", "Gyanesh Kumar"])  # =sir is case-sensitive; plain 'sir' is not
        self.assertEqual(collect.find_terms("sirens", ["=SIR"]), [])
        self.assertEqual(collect.find_terms("नीट पर प्रदर्शन", ["प्रदर्शन"]), ["प्रदर्शन"])

    def test_status(self):
        m = {"id": "x"}
        self.assertEqual(status_for(m, date(2026, 10, 4), TODAY), "active")   # 21 days: still active
        self.assertEqual(status_for(m, date(2026, 10, 3), TODAY), "quiet")    # 22 days
        self.assertEqual(status_for({"id": "x", "ended": "2026-07-25"}, TODAY, TODAY), "ended")

    def test_parse_feeds(self):
        rss = collect.parse_feed(FEEDS[0][1])
        self.assertEqual(len(rss), 5)
        self.assertEqual(rss[0]["published"], date(2026, 10, 24))
        self.assertNotIn("<", rss[0]["snippet"])
        atom = collect.parse_feed(FEEDS[1][1])
        self.assertEqual(atom[0]["link"], "https://example-atom.test/lucknow-nhm-strike")
        self.assertEqual(atom[0]["published"], date(2026, 10, 24))   # 06:15 +05:30

    def test_publication_dates_are_indian_dates(self):
        # outlets publish on Indian time; converting to UTC filed anything from midnight to 05:30 IST a day early
        self.assertEqual(collect.parse_pub_date("Sat, 07 Nov 2026 20:00:00 GMT"), date(2026, 11, 8))   # 01:30 IST
        self.assertEqual(collect.parse_pub_date("Sun, 08 Nov 2026 01:30:00 +0530"), date(2026, 11, 8))
        self.assertEqual(collect.parse_pub_date("2026-11-07T18:00:00Z"), date(2026, 11, 7))            # 23:30 IST
        self.assertEqual(collect.parse_pub_date("2026-11-08"), date(2026, 11, 8))

    def test_aggregator_links_go_to_the_article_and_credit_its_outlet(self):
        items = collect.parse_feed(BING)
        self.assertEqual(items[0]["link"], "https://www.example-news.test/northeast/farmers-protest-kohima?utm_source=rss")
        self.assertEqual(items[0]["source"], "Example News")
        search = {"name": "Bing News: protest India", "aggregator": True}
        self.assertEqual(collect.outlet_for(items[0], search), "Example News")
        self.assertEqual(collect.outlet_for(items[1], search), "other-paper.test")    # no outlet named: its web address
        self.assertEqual(collect.outlet_for(items[0], {"name": "The Hindu"}), "The Hindu")  # ordinary feeds keep their name
        self.assertEqual(collect.unwrap_link("https://www.thehindu.com/news/a.ece?url=https://x.test"), "https://www.thehindu.com/news/a.ece?url=https://x.test")

    def test_feeds_sent_compressed_or_with_a_bom_still_parse(self):
        import gzip
        raw = FEEDS[0][1]
        self.assertEqual(collect.decode_body(gzip.compress(raw)), raw)   # some servers compress without being asked
        self.assertEqual(len(collect.parse_feed(b"\xef\xbb\xbf\n" + raw)), 5)
        with self.assertRaises(ValueError):                               # and a small download must not unpack into a huge one
            collect.decode_body(gzip.compress(b"x" * (collect.MAX_BYTES + 10)))

    def test_rejects_entity_bombs(self):
        bomb = b'<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><rss><channel><item><title>&b;</title><link>https://x.test/a</link></item></channel></rss>'
        with self.assertRaises(Exception):
            collect.parse_feed(bomb)


class TestPipeline(Tmp):
    def test_collect_is_selective_and_idempotent(self):
        new = collect.collect(FEEDS, data=self.data, today=TODAY)
        by_title = {c["title"]: c for c in new}
        self.assertEqual(len(new), 3, [c["title"] for c in new])
        sir = by_title["Hundreds detained as protesters demand Gyanesh Kumar resign over SIR"]
        self.assertEqual(sir["suggested_movement"], "anti-sir-2026")
        self.assertEqual(sir["url"], "https://example-news.test/india/sir-protest-detained/")  # tracking parameters removed
        nhm = by_title["Nurses begin indefinite strike in Lucknow; NHM contract staff demand permanent jobs"]
        self.assertEqual(nhm["suggested_movement"], "up-nhm-staff-2026")
        dharna = by_title["Villagers stage dharna over water shortage in Bundelkhand"]
        self.assertIsNone(dharna["suggested_movement"])
        for c in new:  # nothing but metadata is stored
            self.assertEqual(set(c), {"id", "url", "title", "outlet", "published", "collected", "suggested_movement", "score", "matched", "alternatives"})
        self.assertEqual(validate.check_dataset(self.data, CHECK_DAY), [])
        self.assertEqual(collect.collect(FEEDS, data=self.data, today=TODAY), [])  # second run finds nothing new

    def test_place_filters_and_aggregator_outlets(self):
        regional = b"""<rss><channel>
<item><title>NSF stages protest in Kohima over recruitment</title><link>https://np.test/nsf-kohima</link>
<description>KOHIMA, NOV 9 (NPN): Students protested outside the directorate.</description><pubDate>Mon, 09 Nov 2026 06:00:00 +0530</pubDate></item>
<item><title>Opposition protest in Delhi over voter rolls</title><link>https://np.test/delhi-wire</link>
<description>NEW DELHI, NOV 9 (PTI): Opposition parties protested in the capital.</description><pubDate>Mon, 09 Nov 2026 06:00:00 +0530</pubDate></item>
</channel></rss>"""
        day = date(2026, 11, 9)
        post = {"name": "Nagaland Post", "require_terms": ["Kohima", "=NSF", "=Mon"]}
        self.assertEqual([c["url"] for c in collect.collect([(post, regional)], data=self.data, today=day)], ["https://np.test/nsf-kohima"])
        found = collect.collect([({"name": "Bing News: protest India", "aggregator": True}, BING)], data=self.data, today=day)
        by_outlet = {c["outlet"]: c for c in found}
        self.assertEqual(set(by_outlet), {"Example News", "other-paper.test"})   # the MSN copy is skipped: we cite the original
        self.assertEqual(by_outlet["Example News"]["url"], "https://www.example-news.test/northeast/farmers-protest-kohima")
        self.assertEqual(validate.check_dataset(self.data, day), [])

    def test_promote_reject_and_validate(self):
        new = collect.collect(FEEDS, data=self.data, today=TODAY)
        sir = next(c for c in new if c["suggested_movement"] == "anti-sir-2026")
        nhm = next(c for c in new if c["suggested_movement"] == "up-nhm-staff-2026")
        dharna = next(c for c in new if c["suggested_movement"] is None)
        n_before = len(load_reports(self.data))
        path = curate.promote(sir["id"], movement="anti-sir-2026", read=True, today=TODAY, data=self.data,
                              summary="Police detain hundreds who marched against the voter roll revision.")
        self.assertTrue(path.exists())
        self.assertEqual(len(load_reports(self.data)), n_before + 1)
        self.assertFalse((self.data / "inbox" / f"{sir['id']}.json").exists())
        with self.assertRaises(curate.CurateError):   # too short a summary is refused
            curate.promote(nhm["id"], movement="up-nhm-staff-2026", read=False, summary="Short.", today=TODAY, data=self.data)
        with self.assertRaises(curate.CurateError):   # unknown movement
            curate.promote(nhm["id"], movement="nope", read=False, summary="x" * 30, today=TODAY, data=self.data)
        curate.reject(dharna["id"], "local issue, not tracked", data=self.data)
        self.assertEqual(validate.check_dataset(self.data, CHECK_DAY), [])
        self.assertEqual([c for c in collect.collect(FEEDS, data=self.data, today=TODAY) if c["id"] == dharna["id"]], [])
        with self.assertRaises(curate.CurateError):   # same article twice under one movement
            curate.add_report(url=sir["url"], outlet=sir["outlet"], report_date=sir["published"], movement="anti-sir-2026",
                              summary="Duplicate of the report above, should be refused.", read=True, data=self.data)
        # ...but one article may sit under two movements (e.g. a labour roundup)
        curate.add_report(url=sir["url"], outlet=sir["outlet"], report_date=sir["published"], movement="neet-jantar-mantar-2026",
                          summary="Mentions the earlier NEET protest as background to the new campaign.", read=True, data=self.data, today=TODAY)
        self.assertEqual(validate.check_dataset(self.data, CHECK_DAY), [])

    def test_validator_catches_mistakes(self):
        p = next((self.data / "reports").glob("*/*/*.json"))
        original = p.read_text(encoding="utf-8")
        r = read_json(p)
        r["movement"] = "does-not-exist"
        p.write_text(json.dumps(r))
        errs = validate.check_dataset(self.data, CHECK_DAY)
        self.assertTrue(any("unknown movement" in e for e in errs), errs)
        r = json.loads(original)
        r["summary"] = "too short"
        p.write_text(json.dumps(r))
        self.assertTrue(any("summary" in e for e in validate.check_dataset(self.data, CHECK_DAY)))
        p.write_text(original)
        self.assertEqual(validate.check_dataset(self.data, CHECK_DAY), [])
        (self.data / "movements" / "stub.json").write_text(json.dumps({"id": "stub"}))
        self.assertTrue(any("stub.json" in e for e in validate.check_dataset(self.data, CHECK_DAY)))

    def _candidate(self, cid, url, published):
        # a real inbox entry, with its id, link and date changed
        c = json.loads(self.template)
        c.update({"id": cid, "url": url, "published": published})
        c.pop("ai", None)
        (self.data / "inbox" / f"{cid}.json").write_text(json.dumps(c))
        return c

    def test_published_and_stale_stories_leave_the_waiting_list(self):
        published_url = load_reports(self.data)[0]["url"]
        self.template = sorted((self.data / "inbox").glob("*.json"))[0].read_text()
        for f in (self.data / "inbox").glob("*.json"):
            f.unlink()
        self._candidate("aaaaaaaaaa", published_url, "2026-11-07")              # approved in another pull request
        self._candidate("bbbbbbbbbb", "https://example.test/fresh", "2026-11-07")
        self._candidate("cccccccccc", "https://example.test/old", "2026-10-01")  # five weeks old
        self._candidate("dddddddddd", "https://example.test/undated", None)
        warnings: list[str] = []
        validate.check_dataset(self.data, CHECK_DAY, warnings=warnings)
        self.assertTrue(any("aaaaaaaaaa" in w and "already published" in w for w in warnings), warnings)
        self.assertTrue(any("dddddddddd" in w and "no publication date" in w for w in warnings), warnings)
        movements = build.assemble(self.data, CHECK_DAY, 21)
        shown = {w["url"] for w in build.waiting_for_review(self.data, movements, CHECK_DAY)}
        self.assertIn("https://example.test/fresh", shown)
        self.assertFalse(shown & {published_url, "https://example.test/old", "https://example.test/undated"}, shown)
        # the collector tidies the inbox before it collects, so its pull request carries the clean-up
        collect.collect([], data=self.data, today=CHECK_DAY)
        self.assertFalse((self.data / "inbox" / "aaaaaaaaaa.json").exists())
        self.assertTrue((self.data / "inbox" / "bbbbbbbbbb.json").exists())

    def test_ended_movement_with_a_later_report_is_flagged(self):
        p = self.data / "movements" / "manipur-protests-2026.json"
        m = read_json(p)
        m["ended"] = "2026-06-01"
        p.write_text(json.dumps(m))
        warnings: list[str] = []
        self.assertEqual(validate.check_dataset(self.data, CHECK_DAY, warnings=warnings), [])
        self.assertTrue(any("manipur-protests-2026" in w and "marked ended" in w for w in warnings), warnings)

    def test_new_movement_stub_fails_until_filled(self):
        curate.new_movement("test-stub", data=self.data)
        self.assertTrue(any("TODO" in e for e in validate.check_dataset(self.data, CHECK_DAY)))


class TestBuild(Tmp):
    def test_build(self):
        import csv, re
        out = self.dir / "site"
        stats = build.build(out=out, today=TODAY, data=self.data)
        self.assertEqual(stats, {"movements": 31, "reports": 93, "active": 12})
        movements = {m["id"]: m for m in read_json(out / "data" / "movements.json")}
        self.assertEqual(movements["neet-jantar-mantar-2026"]["status"], "ended")
        self.assertEqual(movements["ladakh-statehood"]["status"], "quiet")
        self.assertEqual(movements["anti-sir-2026"]["report_count"], 21)
        # the app page carries the whole dataset, safely embedded
        index = (out / "index.html").read_text(encoding="utf-8")
        blob = re.search(r'<script type="application/json" id="andolan-data">(.*?)</script>', index, re.S).group(1)
        embedded = json.loads(blob)
        self.assertEqual(embedded["today"], "2026-10-25")
        self.assertEqual(len(embedded["movements"]), 31)
        self.assertNotIn("keywords", embedded["movements"][0])            # matching terms stay out of the page
        self.assertEqual(len(embedded["map"]["states"]), 36)               # every state and union territory
        self.assertIn("Survey of India", embedded["map"]["source"])
        self.assertTrue(all(m.get("locations") for m in embedded["movements"]))
        self.assertTrue(all(m.get("context") for m in embedded["movements"]))  # every movement explains its issue
        sir = next(m for m in embedded["movements"] if m["id"] == "anti-sir-2026")
        self.assertIn("Special Intensive Revision", sir["context"]["explainer"][0])
        self.assertEqual([m["status"] for m in embedded["movements"]][:7], ["active"] * 7)  # active first
        for name in ("assets/app.js", "assets/style.css", "feed.xml", "about.html"):
            self.assertTrue((out / name).exists(), name)
        # permanent movement pages work without JavaScript
        self.assertEqual(len(list((out / "m").glob("*.html"))), 31)
        neet = (out / "m" / "neet-jantar-mantar-2026.html").read_text(encoding="utf-8")
        self.assertIn("Began 21 Jun 2026, ended 25 Jul 2026", neet)  # its own dates, not its latest report
        self.assertIn("(headline only)", neet)
        self.assertIn('location.replace("../index.html#neet-jantar-mantar-2026")', neet)
        sir_page = (out / "m" / "anti-sir-2026.html").read_text(encoding="utf-8")
        self.assertEqual(sir_page.count("<li><b>"), 21)
        self.assertIn("Background: What is the SIR", sir_page)
        with (out / "data" / "reports.csv").open(encoding="utf-8", newline="") as fh:
            self.assertEqual(len(list(csv.DictReader(fh))), 93)
        self.assertIn("<entry>", (out / "feed.xml").read_text(encoding="utf-8"))

    def test_status_rolls_over_with_the_calendar(self):
        out = self.dir / "later"
        stats = build.build(out=out, today=date(2026, 12, 25), data=self.data)
        self.assertEqual(stats["active"], 0)

    def test_html_is_escaped(self):
        p = next((self.data / "reports").glob("2026/10/*.json"))
        r = read_json(p)
        r["summary"] = "A summary with <script>alert(1)</script> inside it, to prove escaping."
        p.write_text(json.dumps(r))
        out = self.dir / "esc"
        build.build(out=out, today=TODAY, data=self.data)
        pages = "".join(f.read_text(encoding="utf-8") for f in out.rglob("*.html"))
        self.assertNotIn("<script>alert(1)", pages)
        self.assertNotIn("</script>alert", pages)
        self.assertIn("\\u003cscript\\u003ealert(1)", pages)   # escaped inside the embedded JSON


class TestArchive(unittest.TestCase):
    class Resp:
        def __init__(self, body=b"", headers=None):
            self._b, self.headers = body, headers or {}
        def read(self): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def test_find_snapshot(self):
        hit = json.dumps({"archived_snapshots": {"closest": {"available": True, "url": "http://web.archive.org/web/2026/https://x.test/a"}}}).encode()
        self.assertEqual(archive.find_snapshot("https://x.test/a", opener=lambda u: self.Resp(hit)), "https://web.archive.org/web/2026/https://x.test/a")
        self.assertIsNone(archive.find_snapshot("https://x.test/a", opener=lambda u: self.Resp(b'{"archived_snapshots": {}}')))

    def test_request_save(self):
        self.assertEqual(archive.request_save("https://x.test/a", opener=lambda u: self.Resp(headers={"Content-Location": "/web/2026/https://x.test/a"})),
                         "https://web.archive.org/web/2026/https://x.test/a")
        self.assertIsNone(archive.request_save("https://x.test/a", opener=lambda u: self.Resp(headers={})))


if __name__ == "__main__":
    unittest.main()
