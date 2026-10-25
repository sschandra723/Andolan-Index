import copy
import unittest
from datetime import date

from andolan.build import assemble, client_data, load_site_config
from andolan.common import DATA
from andolan.coverage import coverage, source_key

TODAY = date(2026, 10, 25)


def rep(mid, day, outlet, kind="news", summary="A march is held.", read=True):
    return {"id": f"{day}-{outlet.lower().replace(' ', '-')}-{mid[:4]}", "movement": mid, "date": day, "outlet": outlet,
            "kind": kind, "url": "https://example.org/" + outlet, "summary": summary, "read": read}


def mv(mid, reports, status="active"):
    reports = sorted(reports, key=lambda r: (r["date"], r["id"]), reverse=True)
    return {"id": mid, "status": status, "reports": reports, "report_count": len(reports)}


class TestCoverage(unittest.TestCase):
    def test_source_key_folds_syndicated_copies(self):
        self.assertEqual(source_key("ThePrint (PTI)"), "pti")
        self.assertEqual(source_key("China Daily Asia (Bloomberg)"), source_key("Bloomberg"))
        self.assertEqual(source_key("Al Jazeera"), "al jazeera")

    def test_real_dataset(self):
        movements = assemble(DATA, TODAY, 21)
        out = client_data(load_site_config(), movements, [], TODAY)
        lead = out["lead"]
        self.assertEqual((lead["basis"], lead["lead"], lead["from"], lead["to"]), ("coverage", "anti-sir-2026", "2026-10-19", "2026-10-25"))
        sir = next(m for m in out["movements"] if m["id"] == "anti-sir-2026")
        # three reports on 23 October, but two of them are the same Bloomberg story
        self.assertEqual((sir["coverage"]["reports"], sir["coverage"]["outlets"], sir["coverage"]["rank"]), (3, 2, 1))
        self.assertEqual(len(sir["coverage"]["daily"]), 14)
        self.assertEqual(sum(sir["coverage"]["daily"]), sir["coverage"]["reports"] + sir["coverage"]["prev_reports"])
        # of the three, the one reporting detentions leads
        self.assertTrue(lead["lead_report"].startswith("2026-10-23-business-standard"))
        # the archive downloads are not touched by the ranking
        self.assertNotIn("coverage", movements[0])

    def test_lead_follows_this_weeks_news_not_the_archive(self):
        big_archive = mv("old-big", [rep("old-big", f"2026-09-{d:02d}", f"Outlet {d}") for d in range(1, 29)] +
                         [rep("old-big", "2026-10-24", "Outlet A")])
        breaking = mv("breaking", [rep("breaking", "2026-10-24", "Outlet B"), rep("breaking", "2026-10-25", "Outlet C"),
                                   rep("breaking", "2026-10-25", "Outlet D", summary="Police detain 40 protesters.")])
        out = coverage([big_archive, breaking], TODAY)
        self.assertEqual(out["lead"], "breaking")
        self.assertEqual(out["order"], ["breaking", "old-big"])
        # two reports on the newest day; the one reporting detentions leads
        self.assertIn("outlet-d", out["lead_report"])

    def test_reference_pages_and_old_reports_do_not_count(self):
        a = mv("a", [rep("a", "2026-10-24", "Wikipedia", kind="reference"), rep("a", "2026-10-25", "Britannica", kind="reference"),
                     rep("a", "2026-10-10", "Old News")])
        b = mv("b", [rep("b", "2026-10-20", "Small Paper")])
        out = coverage([a, b], TODAY)
        self.assertEqual(out["lead"], "b")
        self.assertEqual(a["coverage"]["reports"], 0)
        self.assertIsNone(a["coverage"]["rank"])

    def test_ties_go_to_more_reports_then_most_recent(self):
        a = mv("a", [rep("a", "2026-10-20", "X"), rep("a", "2026-10-21", "X")])
        b = mv("b", [rep("b", "2026-10-24", "Y")])
        c = mv("c", [rep("c", "2026-10-22", "Z")])
        out = coverage([b, c, a], TODAY)
        self.assertEqual(out["order"], ["a", "b", "c"])

    def test_quiet_week_falls_back_to_latest_unended(self):
        ended = mv("ended", [rep("ended", "2026-09-30", "X")], status="ended")
        quiet = mv("quiet", [rep("quiet", "2026-09-20", "Y")], status="quiet")
        out = coverage([ended, quiet], TODAY)
        self.assertEqual((out["basis"], out["lead"], out["order"]), ("latest", "quiet", []))
        self.assertEqual(coverage([], TODAY)["lead"], None)

    def test_today_rolls_the_window(self):
        movements = copy.deepcopy([m for m in assemble(DATA, TODAY, 21)])
        later = coverage(movements, date(2026, 11, 20))
        self.assertEqual(later["basis"], "latest")
        self.assertEqual(later["from"], "2026-11-14")


if __name__ == "__main__":
    unittest.main()
