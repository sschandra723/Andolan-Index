import json
import os
import re
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

from andolan import ai, build, collect, curate, validate
from andolan.common import DATA, read_json

FIX = Path(__file__).parent / "fixtures"
TODAY = date(2026, 10, 25)
ARTICLE_HTML = (FIX / "article_sir.html").read_text(encoding="utf-8")
ARTICLE = ai.extract_text(ARTICLE_HTML)
FEEDS = [({"name": "Sample India Desk", "require_india": False}, (FIX / "rss_sample.xml").read_bytes()),
         ({"name": "Sample Atom Desk", "require_india": True}, (FIX / "atom_sample.xml").read_bytes())]

GOOD = {
    "is_protest_in_india": True, "movement": "anti-sir-2026", "new_movement": None,
    "summary": "Police detained more than 150 people at a march to the Election Commission in New Delhi; organisers put turnout at 5,000 and police at 1,200.",
    "facts": [{"claim": "150 detained", "quote": "Police detained more than 150 protesters near the Election Commission office in New Delhi"},
              {"claim": "turnout", "quote": "Organisers claimed 5,000 people took part; police put the number at 1,200."}],
    "signals": {"detentions": True, "deaths": False, "injuries": False, "internet_shutdown": False, "court_order": False, "new_city": False},
    "background_note": None, "confidence": 0.9,
}


class FakeModel:
    """Stands in for Ollama or Claude: returns a fixed JSON reply and records what it was asked."""
    name = "fake:test"

    def __init__(self, reply):
        self.reply, self.prompts = reply, []

    def complete(self, system, prompt, schema):
        self.prompts.append(prompt)
        return self.reply if isinstance(self.reply, str) else json.dumps(self.reply)


class TestExtractAndVerify(unittest.TestCase):
    def test_extract_keeps_article_drops_chrome(self):
        self.assertIn("Police detained more than 150 protesters", ARTICLE)
        self.assertNotIn("tracking", ARTICLE)
        self.assertNotIn("Sport | Business", ARTICLE)
        fallback = ai._TextParser(); fallback.feed(ARTICLE_HTML)
        self.assertTrue(any("5,000" in t for _, t in fallback.paras))

    def test_good_draft_passes(self):
        res = ai.verify(GOOD, ARTICLE)
        self.assertTrue(res["passed"], res["problems"])
        self.assertEqual(res["quotes_found"], "2/2")

    def test_invented_number_quote_and_name_fail(self):
        bad = dict(GOOD, summary="Police detained 300 people as Rahul Gandhi led a march to the Election Commission in New Delhi.")
        bad["facts"] = GOOD["facts"] + [{"claim": "x", "quote": "the minister resigned on Sunday"}]
        res = ai.verify(bad, ARTICLE)
        self.assertFalse(res["passed"])
        joined = " ".join(res["problems"])
        self.assertIn("number 300", joined)
        self.assertIn("Rahul Gandhi", joined)
        self.assertIn("quote not in article", joined)

    def test_no_text_means_not_checked(self):
        self.assertFalse(ai.verify(GOOD, "")["passed"])

    def test_hindi_article_checks_quotes_and_numbers_not_names(self):
        article = "रांची में 108 एंबुलेंस कर्मियों ने 26 अक्टूबर से हड़ताल का ऐलान किया। वेतन जुलाई से नहीं मिला है।"
        draft = dict(GOOD, summary="Ambulance workers in Ranchi say they will strike from 26 October because salaries have been unpaid since July.",
                     facts=[{"claim": "strike date", "quote": "26 अक्टूबर से हड़ताल का ऐलान किया"}])
        res = ai.verify(draft, article)
        self.assertTrue(res["passed"], res["problems"])
        self.assertFalse(res["names_checked"])

    def test_json_reply_parsing(self):
        self.assertEqual(ai.parse_json_reply('```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(ai.parse_json_reply('Here you go: {"a": 2} hope that helps'), {"a": 2})
        with self.assertRaises(ai.ModelError):
            ai.parse_json_reply("no json here")


class TestImportance(unittest.TestCase):
    def test_formula(self):
        reports = [{"movement": "m", "outlet": o, "date": d} for o, d in
                   [("A", "2026-10-24"), ("B", "2026-10-24"), ("C", "2026-10-20"), ("D", "2026-10-12")]]
        score, why = ai.importance("m", {"detentions": True, "deaths": True}, reports, [], TODAY)
        # 2 outlets in 48h = 20; this week 3 vs last week 1 = +10; deaths 15 + detentions 10 = 25
        self.assertEqual(score, 55)
        self.assertIn("2 outlets in the last 48 hours", why)
        self.assertIn("deaths", why)
        self.assertEqual(ai.importance("new", {}, [], [], TODAY)[0], 15)
        self.assertLessEqual(ai.importance("m", {k: True for k in ai.SIGNALS}, reports * 5, [], TODAY)[0], 100)


class TestRun(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.data = self.dir / "data"
        shutil.copytree(DATA, self.data)
        shutil.rmtree(self.data / "inbox"); (self.data / "inbox").mkdir()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.cands = collect.collect(FEEDS, data=self.data, today=TODAY)
        self.sir = next(c for c in self.cands if c["suggested_movement"] == "anti-sir-2026")
        self.cfg = dict(ai.DEFAULTS, max_articles_per_run=10)

    def fetch(self, url, limit):
        if url == self.sir["url"]:
            return ARTICLE[:limit]
        raise TimeoutError("site did not answer")

    def test_run_drafts_checks_and_scores(self):
        model = FakeModel(GOOD)
        done = ai.run(model, data=self.data, today=TODAY, cfg=self.cfg, fetcher=self.fetch)
        self.assertEqual(len(done), len(self.cands))
        sir = read_json(self.data / "inbox" / f"{self.sir['id']}.json")
        self.assertTrue(sir["ai"]["checks"]["passed"])
        self.assertGreater(sir["ai"]["importance"], 0)
        self.assertEqual(sir["ai"]["model"], "fake:test")
        # stories whose page could not be read are drafted from the headline but flagged
        other = next(c for c in map(lambda c: read_json(self.data / "inbox" / f"{c['id']}.json"), self.cands) if c["id"] != self.sir["id"])
        self.assertFalse(other["ai"]["checks"]["passed"])
        self.assertIn("TimeoutError", other["ai"]["fetch_note"])
        # the article text is used, never stored
        self.assertNotIn("Ignore all previous instructions", json.dumps(sir))
        # the prompt fences the article as data and lists our movements
        self.assertIn("<<<", model.prompts[0]); self.assertIn("anti-sir-2026", model.prompts[0])
        self.assertEqual(validate.check_dataset(self.data, TODAY), [])
        self.assertEqual(ai.run(model, data=self.data, today=TODAY, cfg=self.cfg, fetcher=self.fetch), [])  # nothing twice
        body = ai.pr_summary(self.data)
        self.assertIn("passed checks", body); self.assertIn("needs checking", body)

    def test_unknown_movement_from_model_is_not_trusted(self):
        ai.run(FakeModel(dict(GOOD, movement="made-up-id")), data=self.data, today=TODAY, cfg=self.cfg, fetcher=self.fetch)
        sir = read_json(self.data / "inbox" / f"{self.sir['id']}.json")
        self.assertEqual(sir["ai"]["movement"], "new")
        self.assertEqual(validate.check_dataset(self.data, TODAY), [])

    def test_editor_approves_ai_drafts(self):
        ai.run(FakeModel(GOOD), data=self.data, today=TODAY, cfg=self.cfg, fetcher=self.fetch)
        written = curate.accept_ai(data=self.data, today=TODAY)
        self.assertEqual(len(written), 1)  # only the draft that passed its checks
        rep = read_json(written[0])
        self.assertEqual(rep["drafted_by"], "ai"); self.assertTrue(rep["read"]); self.assertEqual(rep["movement"], "anti-sir-2026")
        other = next(c for c in self.cands if c["id"] != self.sir["id"])
        with self.assertRaises(curate.CurateError):  # a failed draft is refused...
            curate.promote(other["id"], movement="anti-sir-2026", data=self.data, today=TODAY)
        p = curate.promote(other["id"], movement="up-nhm-staff-2026", data=self.data, today=TODAY,  # ...unless the editor writes their own
                           summary="Contract staff in Lucknow begin an indefinite strike over pay and permanent posts.")
        self.assertEqual(read_json(p)["drafted_by"], "person")
        self.assertEqual(validate.check_dataset(self.data, TODAY), [])

    def test_new_movement_from_ai_proposal_still_needs_an_editor(self):
        prop = dict(GOOD, movement="new", new_movement={"name": "Test movement for water rights", "short_name": "Water rights",
                                                        "cause": "Rights", "states": ["Uttar Pradesh"], "places": "Bundelkhand"})
        ai.run(FakeModel(prop), data=self.data, today=TODAY, cfg=self.cfg, fetcher=self.fetch)
        curate.new_movement("water-rights-2026", data=self.data, from_candidate=self.sir["id"])
        m = read_json(self.data / "movements" / "water-rights-2026.json")
        self.assertEqual(m["places"], "Bundelkhand")
        self.assertTrue(any("TODO" in e for e in validate.check_dataset(self.data, TODAY)))

    def test_site_shows_waiting_headlines_but_never_ai_text(self):
        ai.run(FakeModel(GOOD), data=self.data, today=TODAY, cfg=self.cfg, fetcher=self.fetch)
        os.environ["ANDOLAN_AI_AUTONOMY"] = "links"
        self.addCleanup(os.environ.pop, "ANDOLAN_AI_AUTONOMY", None)
        out = self.dir / "site"
        build.build(out=out, today=TODAY, data=self.data)
        html = (out / "index.html").read_text(encoding="utf-8")
        blob = json.loads(re.search(r'id="andolan-data">(.*?)</script>', html, re.S).group(1))
        self.assertTrue(blob["waiting"])
        self.assertEqual(set(blob["waiting"][0]), {"title", "outlet", "url", "published", "movement", "importance"})
        self.assertNotIn(GOOD["summary"], html)
        os.environ["ANDOLAN_AI_AUTONOMY"] = "review"
        build.build(out=out, today=TODAY, data=self.data)
        blob = json.loads(re.search(r'id="andolan-data">(.*?)</script>', (out / "index.html").read_text(encoding="utf-8"), re.S).group(1))
        self.assertEqual(blob["waiting"], [])


class TestProviders(unittest.TestCase):
    def test_request_shapes(self):
        calls = []
        def fake_post(url, body, headers, timeout=600):
            calls.append((url, json.loads(json.dumps(body)), headers))
            if "11434" in url and "think" in body and len(calls) == 1:
                raise ai.ModelError('HTTP 400: {"error":"model does not support think"}')
            if "anthropic" in url:
                return {"content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": '{"ok": true}'}]}
            return {"message": {"content": '{"ok": true}'}}
        orig = ai._post_json
        ai._post_json = fake_post
        try:
            self.assertEqual(ai.OllamaModel("http://localhost:11434", "qwen3:4b").complete("s", "p", ai.DRAFT_SCHEMA), '{"ok": true}')
            self.assertIn("think", calls[0][1]); self.assertNotIn("think", calls[1][1])  # retried without the flag
            self.assertEqual(calls[1][1]["format"], ai.DRAFT_SCHEMA)
            self.assertEqual(ai.AnthropicModel("claude-haiku-5-5", "k").complete("s", "p", ai.DRAFT_SCHEMA), '{"ok": true}')
            url, body, headers = calls[-1]
            self.assertEqual(url, "https://api.anthropic.com/v1/messages")
            self.assertEqual(body["model"], "claude-haiku-5-5"); self.assertEqual(headers["x-api-key"], "k")
            self.assertEqual(headers["anthropic-version"], "2023-06-01")
        finally:
            ai._post_json = orig

    def test_missing_key_is_a_clear_error(self):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with self.assertRaises(ai.ModelError) as e:
            ai.make_model(dict(ai.DEFAULTS, provider="anthropic"))
        self.assertIn("ANTHROPIC_API_KEY", str(e.exception))


if __name__ == "__main__":
    unittest.main()
