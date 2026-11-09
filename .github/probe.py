"""Temporary: run the new collector against the live feeds from GitHub's servers, on a throwaway copy of the data."""
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, ".")
from andolan import collect  # noqa: E402
from andolan.common import CONFIG, DATA, read_json  # noqa: E402

docs = []
for f in [f for f in read_json(CONFIG / "feeds.json")["feeds"] if f.get("enabled", True)]:
    try:
        xml = collect.fetch(f["url"], timeout=f.get("timeout", 20))
        n = len(collect.parse_feed(xml))
        print(f"{'ok  ' if n else 'warn'} {f['name']} <{f['url']}>: {n} items")
        docs.append((f, xml))
    except Exception as e:
        print(f"FAIL {f['name']} <{f['url']}>: {type(e).__name__}: {e}")
tmp = Path(tempfile.mkdtemp()) / "data"
shutil.copytree(DATA, tmp)
new = collect.collect(docs, data=tmp)
print(f"\nNEW {len(new)} candidate(s)")
for outlet, n in Counter(c["outlet"] for c in new).most_common():
    print(f"OUTLET {n:3}  {outlet}")
for c in sorted(new, key=lambda c: (c["suggested_movement"] or "~", c["outlet"])):
    print(f"CAND [{c['suggested_movement'] or '-'}] {c['outlet']}: {c['title'][:110]} ({c['published']}) {c['url'][:100]}")
