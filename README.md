# Andolan Index

A public archive of protest movements in India, plus the tools that keep it current.

Every movement is a named file. Every news report about it is a small JSON file filed under that movement. A script
finds new stories, a person reviews them, and a static site and open data downloads are rebuilt from the result.

```
data/movements/*.json          one file per movement (name, aliases, keywords, demands, start/end dates)
data/reports/YYYY/MM/*.json    one file per article, filed under a movement
data/inbox/*.json              stories the collector found, waiting for a person
data/directory.json            other archive sites we link to instead of copying
data/rejected.txt              URLs a reviewer turned down, so they are not suggested again
schema/                        JSON Schemas: the contract for every file above
andolan/                       the tools (Python 3.10+)
config/                        feeds, search terms, site settings
```

## Quick start

```bash
pip install -r requirements.txt
python -m andolan validate           # check all data
python -m unittest discover -s tests # run the tests
python -m andolan build              # writes ./site
python -m http.server -d site 8000   # open http://localhost:8000
```

## The AI assistant

After the collector finds stories, `python -m andolan ai` reads each one and drafts what an editor needs:

- which movement it belongs to (or a proposal for a new one), and whether it is about a protest in India at all;
- a one- or two-sentence summary in English, even for Hindi and other languages, with the exact quote from the
  article behind every fact;
- signals such as detentions, deaths, internet shutdowns or court orders, and a suggested update to the movement's
  background when something big happens.

Code then checks the draft: every quote must appear in the article, and every number and (for English articles)
every name in the summary must too. Importance is a fixed formula, published on the site's "How this works" page:
outlets covering the movement in the last 48 hours, growth in coverage, and the signals above. The pull request lists
stories from most to least important, each with its draft and check result.

**Which model.** Set in `config/ai.json`:

| `provider` | What runs | Needs | Notes |
|---|---|---|---|
| `ollama` (default) | the open model `qwen3:4b` through [Ollama](https://ollama.com), on GitHub's machine during the scheduled run | nothing: no key, no payment | runs while your computer is off; about a 2.5 GB download, cached between runs; slower and less precise than a hosted model, so check its drafts closely |
| `ollama` on your own computer | any Ollama model, e.g. `qwen3:8b` | Ollama installed and running; set `OLLAMA_HOST` | the writing step works without internet; finding and reading articles still needs it |
| `anthropic` | Claude Haiku 5.5 (`claude-haiku-5-5`) through the Anthropic API | an `ANTHROPIC_API_KEY` repository secret | most accurate, best with Indian languages; a small cost per article |
| `off` | nothing | | the collector and keyword matching only |

**How much it can do without you.** `autonomy` in the same file:

- `review`: nothing appears on the site until an editor approves it.
- `links` (default): the headlines and links of stories waiting for review also appear on the front page, labelled
  "Waiting for review". The model's own text is never shown until an editor approves it.

Editors approve drafts with `python -m andolan curate promote <id>` (uses the AI draft if it passed its checks) or
`python -m andolan curate accept-ai` (every draft that passed its checks, for movements already tracked, with
confidence of at least 0.6). Approved reports are labelled "AI-drafted, editor-approved" on the site.

Article text is fetched only to draft the summary (robots.txt is respected) and is never stored. The model is told
to treat article text as data, and code checks its output against the article, which limits what a page with
hidden instructions can make it do; an editor's approval is the final safeguard.

## The loop

1. **Collect, then draft.** The AI assistant drafts each story right after collection (see above).
   **Collect.** `python -m andolan collect` reads the feeds in `config/feeds.json`, keeps stories that look like protest
   coverage, guesses the movement, and writes candidates to `data/inbox/`. It stores the headline, link, outlet and date
   only. A scheduled GitHub Action does this every 6 hours and opens a pull request listing what it found.
2. **Review.** A person opens each link and reads the story, then either:
   - `python -m andolan curate promote <id> --movement <movement-id> --summary "Two sentences in your own words." --read`
   - `python -m andolan curate reject <id> --reason "not about a protest"`
   - `python -m andolan curate add --url ... --outlet ... --date ... --movement ... --summary ...` for articles found by hand
   - `python -m andolan curate new-movement <id>` when a story belongs to a protest we do not track yet. It writes a stub; fill in every TODO.
3. **Merge.** CI runs `validate` and the tests. Merging to `main` rebuilds and publishes the site.
4. **Archive.** `python -m andolan archive` asks the Internet Archive for a saved copy of each report, so links survive link rot.

Active / Quiet / Ended is worked out when the site is built: **Active** if the movement has a report in the last 21
days (`active_days` in `config/site.json`), **Quiet** otherwise, **Ended** only when you set `ended` on the movement.
The deploy workflow also runs daily so labels change as time passes.

## The site

`python -m andolan build` writes one page, `site/index.html`, with the whole dataset and the map embedded in it.
`site_src/app.js` renders every view from that data, so no server is needed:

- **The landing, told as you scroll.** First a header on its own: Andolan Index, what it does, and the date of the
  latest report. Scroll, and the header fades as the map of India rises into the middle of the screen and its border
  draws itself. These movements follow the scroll position exactly, so scrolling back reverses them, and they work the
  same inside an embedded frame. Scroll again, and the map moves to the right, the protests appear on it as points,
  and the hot news comes up beside it (the protest leading the news this week, see below): the lead protest's main article, how many outlets and reports covered it this week against the week
  before, its reports a day over two weeks, and the newest from the other active protests. News cards pop up at the
  places the reports name; pointing at a point shows its newest report. Further down: why the lead protest is
  happening (the map zooms in), everything in the news this week ranked by coverage, quiet movements and the archive.
  Every line of copy is generated from the data. On phones the map pins to the top half and the text scrolls beneath it.
- **The ledger.** Every movement on one shared time axis (6 weeks, 6 months or all time), filterable by status,
  issue, state and search.
- **A page per movement.** Its timeline, what it is about, its demands, every report grouped by month, a small map,
  and a "Cite this page" link that opens a ready-made citation and links to its data.

### Which protest leads

`andolan/coverage.py` decides it every time the site is built (at least daily):

- The lead is the movement the most **different outlets** reported on in the past 7 days. Ties go to more reports in
  that window, then to the most recent report. Copies of an agency story count once: `ThePrint (PTI)` counts as PTI,
  so a PTI story carried by five papers is one source, not five.
- Only journalism counts: `news`, `opinion`, `explainer`, `fact-check` and `roundup`. Reference pages, archive links
  and background pages are not coverage.
- The **lead article** is the newest report in the window. On a tie for the day, a full read beats headline only, news
  beats commentary, and a report of detentions, injuries, deaths, shutdowns or court orders beats one without.
- Approved reports only. Stories waiting for review never move the lead.
- If nothing has been reported in the window, the page leads with the most recently reported movement that has not
  ended and labels it "Latest on the record" instead of "Leading the news".

Change `WINDOW_DAYS` in that file to look further back. The rule is also explained on the site's "How this works" page.

Each movement also gets a permanent URL, `m/<id>.html`. It opens the movement in the app, and lists the reports as
plain HTML for search engines and browsers without JavaScript. The design lives in `site_src/style.css`.

## The map

`site_src/india-map.json` holds the state outlines as ready-to-draw SVG paths, plus the three numbers needed to place
a latitude and longitude on them. It is built from DataMeet's state boundaries
([datameet/maps](https://github.com/datameet/maps/tree/master/States), CC BY 4.0), which follow the official boundary
of India as published by the Survey of India: all of Jammu and Kashmir and Ladakh, including Gilgit-Baltistan and
Aksai Chin, and all of Arunachal Pradesh. Keep the attribution in the footer if you change the design.

To rebuild it (only needed if boundaries change):

```bash
cd tools && npm install
# download Admin2.shp, .dbf, .shx and .prj from datameet/maps/States into one folder, then:
node make_map.mjs path/to/Admin2.shp ../site_src/india-map.json
```

The tool refuses to write the file unless Gilgit, Hunza, Skardu, Aksai Chin and the Shaksgam Valley fall inside
Ladakh, Muzaffarabad and Srinagar inside Jammu and Kashmir, and Tawang inside Arunachal Pradesh, and unless the
browser's projection formula matches d3's to within 0.01 px.

Pins come from each movement's `locations` (name, latitude, longitude). Add one point per city or site.

## Data model

A **movement** has: `id` (permanent slug and page URL), `name`, `short_name` (for the map), `aliases`, `keywords`,
`cause`, `states`, `places`, `locations` (points for the map), `started` (`YYYY-MM-DD` or `YYYY-MM`), optional `ended`,
`about`, `demands`, and `context`: a background explainer with a `question` ("What is the SIR, and what does it
change?"), a `short` answer for the landing page, `explainer` paragraphs, `impact` points and the `sources` it was
written from. The explainer appears at the end of the movement's page and in the landing page gallery. Attribute every
contested figure or claim to whoever made it, and list only sources you have actually read.

A **report** has: `id`, `movement`, `date`, `outlet`, `kind` (news, explainer, opinion, reference, fact-check, archive,
background, roundup), `url`, `archive_url`, `summary`, `read`, `added`.

- One article may be filed under several movements (a labour roundup, for instance), once each. Each filing has its own summary.
- `read` is `true` only if the full article was read when the summary was written. Otherwise the site shows a
  "headline only" flag and the summary should be treated as provisional.

## Editorial rules

- Write summaries in your own words, one or two sentences. Never paste article text or feed snippets (copyright, and summaries are the value we add).
- Attribute contested claims: casualty figures, crowd sizes, who started a clash. Say who said it.
- Name organisations, office-holders and public leaders. Do not name private individuals who were detained or injured
  unless they have spoken publicly, and never publish addresses or other personal details.
- File fact-checks as reports on the movement they concern; they are how misattributed videos get caught.
- Corrections: fix the file, say what changed in the pull request, keep the `id`.

## Put it online (GitHub Pages)

1. Create a repository and push this folder.
2. **Settings > Pages > Source: GitHub Actions.**
3. **Settings > Actions > General > Workflow permissions:** tick "Allow GitHub Actions to create and approve pull requests".
4. Set `repo_url` in `config/site.json` if you want a "Source and corrections" link in the footer. The site URL is picked up automatically.
5. Run **Actions > Collect new stories** once by hand and read the log. Feeds that fail are listed there.

## Tuning

- **Feeds.** The URLs in `config/feeds.json` were written from memory and have not been tested. Run
  `python -m andolan collect --check-feeds` on a machine with internet access and fix or disable any that fail.
- **What counts as a protest story.** `config/terms.json`. ASCII terms match from the start of a word (`protest` finds
  `protesters`); a leading `=` means exact, case-sensitive (`=SIR`, so "sirens" does not match).
- **Which movement.** Each keyword hit on a movement scores 1, each alias hit scores 2; the best movement wins if it
  reaches `min_score` (2). Everything else lands in the inbox as unsorted, with other possible movements listed.
  Two movements can share keywords (farmers' unions joined the anti-SIR protests), so check suggestions.

## Known limits

- Matching is keyword-based. It will miss stories that use unfamiliar words and will sometimes suggest the wrong movement. That is why a person approves everything.
- Only a few Hindi terms are included and no regional-language feeds are configured. Coverage outside English-language national outlets will be thin until you add feeds and terms.
- The Internet Archive step has been tested against mocked responses only.
- Google News feeds are disabled by default because their links are redirects, not article URLs.

## Licence

Code: MIT (`LICENSE`). Data: CC BY 4.0 (`data/LICENSE.md`). Change either if you prefer something else.
Map boundaries: DataMeet India community, CC BY 4.0.
