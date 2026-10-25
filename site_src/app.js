/* Andolan Index: renders every view from the dataset embedded in the page. No framework, no build step. */
(function () {
  "use strict";
  var dataEl = document.getElementById("andolan-data");
  var app = document.getElementById("app");
  if (!dataEl || !app) return;
  var D = JSON.parse(dataEl.textContent);
  var MAP = D.map;
  var tip = document.getElementById("tip");
  var REDUCE = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MON = MONTHS.map(function (x) { return x.slice(0, 3); });
  var WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  var DAY = 864e5;
  var STATUS = { active: "Active", quiet: "Quiet", ended: "Ended" };
  var STATUS_NOTE = {
    active: "reported on in the last " + D.config.active_days + " days",
    quiet: "no reports in the last " + D.config.active_days + " days",
    ended: "called off or resolved"
  };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ms(s) { var p = s.split("-").map(Number); return Date.UTC(p[0], p[1] - 1, p[2] || 1); }
  function fmt(s, o) {
    o = o || {};
    var p = s.split("-").map(Number), mon = o.short ? MON[p[1] - 1] : MONTHS[p[1] - 1];
    if (!p[2]) return mon + " " + p[0];
    return o.noYear ? p[2] + " " + mon : p[2] + " " + mon + " " + p[0];
  }
  function sameYear(s) { return !!s && s.slice(0, 4) === D.today.slice(0, 4); }
  function lastSeen(m, lead) { return m.latest_report ? (lead || "Last report") + " " + fmt(m.latest_report, { short: true, noYear: sameYear(m.latest_report) }) : "No reports yet"; }
  function plural(n, w, ws) { return n + " " + (n === 1 ? w : (ws || w + "s")); }
  function count(n, w, ws) { return (n <= 10 ? WORDS[n] : n) + " " + (n === 1 ? w : (ws || w + "s")); }
  function list(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  function firstSentence(s) { var i = s.search(/\.\s/); return i > 0 ? s.slice(0, i + 1) : s; }
  function transition(fn) {
    if (!REDUCE && document.startViewTransition) { try { document.startViewTransition(fn); return; } catch (e) { /* fall through */ } }
    fn();
  }
  function project(lon, lat) {
    var p = MAP.projection;
    return [p.tx + p.k * lon * Math.PI / 180, p.ty - p.k * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  }

  /* ---------- data ---------- */
  var M = D.movements, byId = {}, outlets = {};
  var TODAY = ms(D.today);
  M.forEach(function (m, i) {
    byId[m.id] = m;
    m._i = i;
    m._start = ms(m.started);
    m._last = m.latest_report ? ms(m.latest_report) : m._start;
    m._end = m.ended ? ms(m.ended) : m._last;
    m._short = m.short_name || m.name;
    var o = {};
    m.reports.forEach(function (r) { o[r.outlet] = 1; outlets[r.outlet] = 1; });
    m._outlets = Object.keys(o).length;
    m._hay = [m.name, m._short, m.about, m.demands, m.places, m.cause].concat(m.states, m.aliases || [], m.reports.map(function (r) { return r.outlet + " " + r.summary; })).join(" ").toLowerCase();
    m._locs = (m.locations && m.locations.length ? m.locations : m.states.map(function (s) {
      var st = MAP.states.filter(function (x) { return x.name === s; })[0];
      return st ? { name: s, xy: [st.cx, st.cy] } : null;
    }).filter(Boolean)).map(function (l) { return { name: l.name, xy: l.xy || project(l.lon, l.lat) }; });
  });
  var TOTAL_REPORTS = M.reduce(function (n, m) { return n + m.report_count; }, 0);
  var CAUSES = Array.from(new Set(M.map(function (m) { return m.cause; }))).sort();
  var COUNTS = { "": M.length, active: 0, quiet: 0, ended: 0 };
  M.forEach(function (m) { COUNTS[m.status]++; });
  var STATS = {};
  M.forEach(function (m) {
    m.states.forEach(function (st) {
      var o = STATS[st] || (STATS[st] = { moves: [], reports: 0, live: 0 });
      o.moves.push(m); o.reports += m.report_count; if (m.status === "active") o.live++;
    });
  });
  var STATE_NAMES = Object.keys(STATS).filter(function (s) { return s !== "Nationwide"; }).sort();

  // pins: one per movement and place
  var PINS = [];
  M.forEach(function (m) {
    m._pins = [];
    m._locs.forEach(function (l) {
      m._pins.push(PINS.length);
      PINS.push({ m: m, name: l.name, keys: placeKeys(l.name), x: l.xy[0], y: l.xy[1], r: Math.round((3.5 + Math.sqrt(m.report_count) * 0.8) * 2) / 2 });
    });
  });
  function placeKeys(name) {
    var out = [];
    name.split(/,\s*/).forEach(function (part) { out.push(part.toLowerCase(), part.replace(/^New /, "").toLowerCase()); });
    return out;
  }
  // The pin for a report: the place its summary names, else the movement's main place (and then no place is named on the card).
  function pinFor(m, r) {
    var text = r.summary.toLowerCase();
    for (var i = 0; i < m._pins.length; i++) {
      if (PINS[m._pins[i]].keys.some(function (k) { return text.indexOf(k) > -1; })) return { i: m._pins[i], named: true };
    }
    return { i: m._pins[0], named: m._pins.length === 1 };
  }

  // The protest most in the news. Worked out when the site is built (andolan/coverage.py): the movement the most
  // different outlets reported on in the past week, and the article that leads it.
  M.forEach(function (m) { m.coverage = m.coverage || { outlets: 0, reports: 0, prev_outlets: 0, prev_reports: 0, daily: [], rank: null }; });
  var LEAD = (function () {
    var L = D.lead || {}, m = L.lead && byId[L.lead];
    if (!m || !m.reports.length) return null;
    var art = m.reports.filter(function (r) { return r.id === L.lead_report; })[0] || m.reports[0];
    return { m: m, art: art, live: L.basis === "coverage", days: L.days || 7, from: L.from, to: L.to,
      order: (L.order || []).map(function (id) { return byId[id]; }).filter(Boolean) };
  })();
  function onRecord(r) { return r.kind !== "reference" && r.kind !== "archive"; }
  // The reports that pop up on the map: the lead's newest, taking turns with the newest from every other movement.
  var QUEUE = (function () {
    var lead = [], q = [];
    if (LEAD) {
      var rest = LEAD.m.reports.filter(function (r) { return r !== LEAD.art && onRecord(r); });
      lead = [LEAD.art].concat(rest.filter(function (r) { return r.read; }), rest.filter(function (r) { return !r.read; })).slice(0, 4)
        .map(function (r) { return { r: r, m: LEAD.m, lead: true }; });
    }
    var others = M.filter(function (m) { return (!LEAD || m !== LEAD.m) && m.reports.length && m.status !== "ended"; })
      .sort(function (a, b) { return (a.coverage.rank || 99) - (b.coverage.rank || 99) || b._last - a._last; })
      .map(function (m) { return { r: m.reports.filter(function (r) { return onRecord(r) && r.read; })[0] || m.reports.filter(onRecord)[0] || m.reports[0], m: m }; });
    for (var i = 0; i < Math.max(lead.length, others.length); i++) { if (lead[i]) q.push(lead[i]); if (others[i]) q.push(others[i]); }
    return q;
  })();

  /* ---------- time axis ---------- */
  var RANGES = [["weeks", "6 weeks"], ["months", "6 months"], ["all", "All time"]];
  function ticks(a, b) {
    var out = [], d = new Date(a);
    d.setUTCHours(0, 0, 0, 0);
    if ((b - a) / DAY <= 80) {
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
      for (; d.getTime() <= b; d.setUTCDate(d.getUTCDate() + 7)) out.push({ t: d.getTime(), label: d.getUTCDate() + " " + MON[d.getUTCMonth()] });
    } else {
      d.setUTCDate(1);
      if (d.getTime() < a) d.setUTCMonth(d.getUTCMonth() + 1);
      for (var first = true; d.getTime() <= b; d.setUTCMonth(d.getUTCMonth() + 1), first = false) {
        out.push({ t: d.getTime(), label: MON[d.getUTCMonth()] + (first || d.getUTCMonth() === 0 ? " " + d.getUTCFullYear() : "") });
      }
    }
    return out;
  }
  function domain(kind) {
    var start, end = TODAY + 4 * DAY, d;
    if (kind === "weeks") start = TODAY - 42 * DAY;
    else if (kind === "months") { d = new Date(TODAY); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 5); start = d.getTime(); }
    else { d = new Date(Math.min.apply(null, M.map(function (m) { return m._start; }))); d.setUTCDate(1); start = d.getTime(); end = TODAY + 12 * DAY; }
    return { start: start, end: end, ticks: ticks(start, end) };
  }
  function domainFor(m) {
    var a = Math.min.apply(null, [m._start].concat(m.reports.map(function (r) { return ms(r.date); })));
    var b = Math.max(TODAY, m._end), pad = (b - a) * 0.03 + 2 * DAY;
    return { start: a - pad, end: b + pad, ticks: ticks(a - pad, b + pad) };
  }
  function pos(t, dom) { return Math.max(0, Math.min(100, (t - dom.start) / (dom.end - dom.start) * 100)); }

  /* ---------- ui state ---------- */
  var savedRange = null;
  try { savedRange = localStorage.getItem("andolan-range"); } catch (e) { /* storage may be blocked */ }
  var ui = { view: "home", id: null, status: "", cause: "", state: "", q: "", homeScroll: 0, first: true,
    range: RANGES.some(function (r) { return r[0] === savedRange; }) ? savedRange : "weeks" };
  function visible() {
    return M.filter(function (m) {
      return (!ui.status || m.status === ui.status) && (!ui.cause || m.cause === ui.cause) &&
        (!ui.state || m.states.indexOf(ui.state) > -1) && (!ui.q || m._hay.indexOf(ui.q) > -1);
    });
  }

  /* ---------- shared pieces ---------- */
  function nav() {
    var back = ui.view === "home" ? "" : '<button type="button" class="nav-back" data-back aria-label="Back"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Back</span></button>';
    return '<header class="nav gut"><div class="nav-in"><div class="nav-l">' + back + '<a class="brand" href="#" data-go="">Andolan Index</a></div>' +
      '<nav aria-label="Site"><a href="#ledger" data-go="ledger"' + (ui.view === "home" ? ' aria-current="page"' : "") + '>Movements</a>' +
      '<a href="#about" data-go="about"' + (ui.view === "about" ? ' aria-current="page"' : "") + '>How this works</a>' +
      '<a class="opt" href="data/movements.json" target="_blank" rel="noopener">Data</a></nav></div></header>';
  }
  function glyph(status) { return '<span class="glyph g-' + status + '" aria-hidden="true"></span>'; }
  function statesSvg(cls) {
    return MAP.states.map(function (s) {
      return '<path class="st ' + (cls ? cls(s.name) : "") + '" data-state="' + esc(s.name) + '" d="' + s.d + '"></path>';
    }).join("");
  }

  /* ---------- the story ---------- */
  function fmtRange(a, b) {
    var pa = a.split("-").map(Number), pb = b.split("-").map(Number);
    return pa[1] === pb[1] ? pa[2] + "–" + pb[2] + " " + MONTHS[pb[1] - 1] : pa[2] + " " + MON[pa[1] - 1] + " – " + pb[2] + " " + MON[pb[1] - 1];
  }
  function dayLabel(t) { var d = new Date(t); return d.getUTCDate() + " " + MON[d.getUTCMonth()]; }
  function tile(v, word, prev) {
    return '<p class="tile"><b>' + v + '</b><span class="t-l">' + (v === 1 ? word : word + "s") + '</span><span class="t-d">' + prev + ' the week before</span></p>';
  }
  // reports a day over two weeks; the current week in the accent, the week before in grey
  function spark(m) {
    var d = m.coverage.daily || [], n = d.length, half = n / 2, max = Math.max.apply(null, [1].concat(d));
    if (!n) return "";
    var cols = d.map(function (v, i) {
      return '<span class="sp-c' + (i >= half ? " cur" : "") + '" data-tip="' + dayLabel(TODAY - (n - 1 - i) * DAY) + ": " + plural(v, "report") + '"><i style="--h:' + (v ? Math.max(18, v / max * 100) : 0) + '%;--j:' + i + '"></i></span>';
    }).join("");
    return '<figure class="spark"><figcaption>Reports a day</figcaption><div class="sp-bars" style="--n:' + n + '" role="img" aria-label="Reports a day over the past ' + n + ' days, oldest first: ' + d.join(", ") + '.">' + cols + '</div>' +
      '<p class="sp-key" aria-hidden="true"><span>Week before</span><span class="cur">This week</span></p></figure>';
  }
  function item(m, extra) {
    return '<li><a href="#' + m.id + '" data-go="' + m.id + '" data-lit="' + m.id + '">' + glyph(m.status) + '<b>' + esc(m._short) + '</b><small>' + esc(extra) + '</small></a></li>';
  }
  function placesOf(m) { return m._locs.map(function (l) { return l.name; }).join(", "); }

  // The landing is told in stages as you scroll:
  //   0  the header: which protest is leading the news, on its own
  //   1  the map of India appears, its border drawing itself
  //   2  the protests appear on it as points, with the hot news beside them
  //   3  why the lead protest is happening (the map zooms in)
  //   4  everything in the news this week, ranked
  //   5  quiet movements
  //   6  the archive
  var ACTIVE = M.filter(function (m) { return m.status === "active"; });
  function leadKicker() { return LEAD.live ? "Leading the news, " + fmtRange(LEAD.from, LEAD.to) : "Latest on the record"; }
  function headerStep() {
    var k = 0, newest = M.reduce(function (d, m) { return m.latest_report && m.latest_report > d ? m.latest_report : d; }, "");
    return '<section class="step s0" data-step="0"><div class="step-in">' +
      (newest ? '<p class="kicker" style="--k:' + (k++) + '"><i aria-hidden="true"></i>Latest report ' + fmt(newest) + '</p>' : "") +
      '<h1 class="h-hero" style="--k:' + (k++) + '">Andolan Index</h1>' +
      '<p class="h-lede" style="--k:' + (k++) + '">Where India is protesting, and why. Every news report on a protest, filed under the movement it belongs to.</p>' +
      '<p class="hint" style="--k:' + (k++) + '"><i aria-hidden="true"></i>Scroll to see the map</p></div></section>';
  }
  function mapCaption() {
    var record = plural(TOTAL_REPORTS, "report") + ' from ' + plural(Object.keys(outlets).length, "outlet") + ' on record.';
    if (!ACTIVE.length) return '<b>No movement is active right now.</b><span>None has had a new report in the last ' + D.config.active_days + ' days. ' + record + '</span>';
    return '<b>' + count(ACTIVE.length, "movement is", "movements are") + ' active across India.</b><span>' + record + ' Keep scrolling to see where.</span>';
  }
  // On wide screens these words sit above the map in the stage; on phones they scroll in below it.
  function mapStep() { return '<section class="step mapstep" data-step="1"><div class="step-in"><p class="map-cap">' + mapCaption() + '</p></div></section>'; }

  function newsStep() {
    if (!LEAD) return '<section class="step news" data-step="2"><div class="step-in">' + (TOTAL_REPORTS ?
      '<h2>' + count(ACTIVE.length, "movement is", "movements are") + ' active right now.</h2><ul class="mv-list">' + ACTIVE.map(function (m) { return item(m, placesOf(m)); }).join("") + '</ul>' :
      '<h2>No reports yet.</h2><p>Movements appear on the map as soon as the first report on them is approved.</p>') + '</div></section>';
    var m = LEAD.m, c = m.coverage, a = LEAD.art, next = LEAD.order[1], days = LEAD.days;
    var reason = !LEAD.live ? "No protest has new coverage in the past " + days + " days, so this is the one reported most recently." :
      !next || c.outlets > next.coverage.outlets ? "More outlets reported on it in the past " + days + " days than on any other protest." :
      c.reports > next.coverage.reports ? "Tied for the most outlets in the past " + days + " days, with more reports than the rest." :
      "The joint most-covered protest of the past " + days + " days.";
    var hi = /[ऀ-ॿ]/.test(a.summary) ? ' lang="hi"' : "";
    var also = QUEUE.filter(function (x) { return !x.lead && x.m.status === "active"; }).slice(0, 3).map(function (x) {
      var at = pinFor(x.m, x.r);
      return '<li><a href="#' + x.m.id + '" data-go="' + x.m.id + '" data-anchor="r-' + esc(x.r.id) + '" data-lit="' + x.m.id + '"><span class="al-mv">' + glyph(x.m.status) + esc(x.m._short) +
        (at.named ? ', ' + esc(PINS[at.i].name) : "") + '</span><span class="al-sum">' + esc(x.r.summary) + '</span>' +
        '<span class="al-src">' + esc(x.r.outlet) + ', ' + fmt(x.r.date, { short: true, noYear: sameYear(x.r.date) }) + '</span></a></li>';
    }).join("");
    return '<section class="step news" data-step="2"><div class="step-in">' +
      '<p class="kicker"><i aria-hidden="true"></i>' + leadKicker() + '</p>' +
      '<h2><a href="#' + m.id + '" data-go="' + m.id + '">' + esc(m._short) + '</a></h2>' +
      '<article class="lead-art" aria-label="Leading report"><p class="la-src">' + esc(a.outlet) + '<time datetime="' + a.date + '">' + fmt(a.date, { noYear: sameYear(a.date) }) + '</time></p>' +
      '<p class="la-sum"' + hi + '>' + esc(a.summary) + '</p>' +
      '<a class="la-link" href="' + esc(a.url) + '" target="_blank" rel="noopener">Read it at ' + esc(a.outlet) + '</a></article>' +
      (LEAD.live ? '<div class="pulse">' + tile(c.outlets, "outlet", c.prev_outlets) + tile(c.reports, "report", c.prev_reports) + spark(m) + '</div>' : "") +
      '<p class="reason">' + reason + ' <a href="#about" data-go="about" data-anchor="lead-rule">How the lead is chosen</a></p>' +
      '<div class="cta"><a class="btn-primary" href="#' + m.id + '" data-go="' + m.id + '">Read the full file</a>' +
      '<a class="btn-text" href="#why" data-jump="why">Why it is happening</a></div>' +
      (also ? '<div class="also"><h3>Also in the news</h3><ul>' + also + '</ul></div>' : "") + '</div></section>';
  }
  function whyStep(m) {
    var c = m.context;
    return '<section class="step why" id="why" data-step="3"><div class="step-in"><p class="eyebrow">' + esc(m._short) + '</p>' +
      '<h2>' + esc(c ? c.question : "What it is about") + '</h2><p>' + esc(c ? c.short : m.about) + '</p>' +
      (c ? '<ul class="impact">' + c.impact.slice(0, 2).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul>'
         : '<p class="dem"><b>Demands:</b> ' + esc(m.demands) + '</p>') +
      '<div class="cta">' + (c ? '<a class="btn-primary" href="#' + m.id + '" data-go="' + m.id + '" data-anchor="background">Read the background</a>'
         : '<a class="btn-primary" href="#' + m.id + '" data-go="' + m.id + '">Read the full file</a>') + '</div></div></section>';
  }
  // every protest with coverage this week, ranked; the lead in the accent, the rest in grey
  function rankStep() {
    var ranked = LEAD.order, max = Math.max.apply(null, [1].concat(ranked.map(function (m) { return m.coverage.outlets; })));
    var silent = ACTIVE.filter(function (m) { return !m.coverage.reports; });
    var rows = ranked.map(function (m, i) {
      var c = m.coverage;
      return '<li><a href="#' + m.id + '" data-go="' + m.id + '" data-lit="' + m.id + '" aria-label="' + esc(m._short + ", " + placesOf(m) + ": " + plural(c.outlets, "outlet") + ", " + plural(c.reports, "report")) + '">' +
        '<span class="rk-n">' + (i + 1) + '</span><span class="rk-t"><b>' + esc(m._short) + '</b><small>' + esc(placesOf(m)) + ', ' + plural(c.reports, "report") + '</small></span>' +
        '<span class="rk-bar"><i style="--w:' + (c.outlets / max * 100).toFixed(1) + '%"></i></span><span class="rk-v">' + c.outlets + '</span></a></li>';
    }).join("");
    return '<section class="step" data-step="4"><div class="step-in"><h2>' + (ranked.length > 1 ? "Everything in the news this week." : "Nothing else has new coverage this week.") + '</h2>' +
      '<p>How many different outlets reported on each protest, ' + fmtRange(LEAD.from, LEAD.to) + '. Copies of one agency story count once.</p>' +
      (rows ? '<div class="rk"><p class="rk-head" aria-hidden="true"><span>Protest</span><span>Outlets</span></p><ol class="rank">' + rows + '</ol></div>' : "") +
      (silent.length ? '<p class="rk-none"><b>Active, nothing new this week:</b> ' + silent.map(function (m) {
        return '<a href="#' + m.id + '" data-go="' + m.id + '" data-lit="' + m.id + '">' + esc(m._short) + '</a>';
      }).join(", ") + '.</p>' : "") + '</div></section>';
  }

  function storyHtml() {
    var quiet = M.filter(function (m) { return m.status === "quiet"; });
    var ended = M.filter(function (m) { return m.status === "ended"; });
    var steps = [headerStep(), mapStep(), newsStep()];
    if (LEAD) { steps.push(whyStep(LEAD.m)); if (LEAD.live) steps.push(rankStep()); }
    if (quiet.length) {
      steps.push('<section class="step" data-step="5"><div class="step-in"><h2>Quiet is not the same as over.</h2>' +
        '<p>' + count(quiet.length, "movement has", "movements have") + ' had no new reports for ' + D.config.active_days + ' days or more. Their files stay open and grow when the news returns.</p>' +
        '<ul class="mv-list">' + quiet.map(function (m) { return item(m, lastSeen(m)); }).join("") + '</ul></div></section>');
    }
    steps.push('<section class="step" data-step="6"><div class="step-in"><h2>Every report stays on the record.</h2>' +
      '<p>Andolan Index files every news report on India’s protests under the movement it belongs to: ' + plural(TOTAL_REPORTS, "report") + ' from ' + plural(Object.keys(outlets).length, "outlet") + ' so far, each linked to its source' +
      (ended.length ? '. ' + count(ended.length, "movement has", "movements have") + ' ended and stay in the archive' : '') + '. The data is free to reuse.</p>' +
      '<div class="cta"><a class="btn-primary" href="#ledger" data-go="ledger">See every movement on one timeline</a></div></div></section>');
    return '<section class="story' + (ui.first ? " intro" : "") + '" id="story" data-step="0" aria-label="Protests across India">' +
      '<div class="steps">' + steps.join("") + '</div>' +
      '<div class="stage"><p class="stage-cap">' + mapCaption() + '</p><div class="mapwrap">' +
      '<svg class="india" viewBox="0 0 ' + MAP.width + ' ' + MAP.height + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map of India showing where tracked protests are happening">' +
      '<g>' + statesSvg() + '</g><path class="outline" d="' + MAP.outline + '"></path></svg>' +
      '<div class="overlay"></div></div></div></section>';
  }

  var story = null;
  function storyInit() {
    var el = document.getElementById("story");
    if (!el) return;
    var s = story = { el: el, svg: el.querySelector("svg.india"), overlay: el.querySelector(".overlay"), mapwrap: el.querySelector(".mapwrap"),
      cap: el.querySelector(".stage-cap"), outline: el.querySelector(".outline"), head: el.querySelector(".s0"), headIn: el.querySelector(".s0 .step-in"),
      news: el.querySelector(".news"), newsIn: el.querySelector(".news .step-in"), stage: el.querySelector(".stage"), stepEls: Array.prototype.slice.call(el.querySelectorAll(".step")), len: 6000, step: -1, vb: { x: 0, y: 0, w: MAP.width, h: MAP.height },
      raf: 0, timer: 0, release: 0, cards: [], tags: [], idx: 0, held: null, paused: false, screen: [] };
    s.overlay.innerHTML = PINS.map(function (p, i) {
      var label = p.m._short + " in " + p.name + ". " + STATUS[p.m.status] + ", " + plural(p.m.report_count, "report") + ".";
      return '<button type="button" class="pin p-' + p.m.status + (LEAD && p.m === LEAD.m ? " is-lead" : "") + (p.m.coverage.rank ? " in-news" : "") + '" style="--r:' + p.r + 'px;--i:' + i + '" data-pin="' + i + '" data-go="' + p.m.id + '" aria-label="' + esc(label + " Open its file.") + '"><i></i></button>';
    }).join("");
    s.pins = Array.prototype.slice.call(s.overlay.querySelectorAll(".pin"));
    try { s.len = Math.ceil(s.outline.getTotalLength()); s.outline.style.setProperty("--len", s.len); } catch (e) { /* not essential */ }
    s.svg.querySelectorAll(".st").forEach(function (p) {
      var st = STATS[p.dataset.state];
      if (st) p.setAttribute("data-tip", p.dataset.state + ": " + plural(st.moves.length, "movement") + ", " + plural(st.reports, "report") + ". Select to list them.");
    });
    layoutPins();
    if (window.ResizeObserver) { s.ro = new ResizeObserver(function () { if (story === s) layoutPins(); }); s.ro.observe(s.overlay); }
    readScroll();
    if (ui.first) { setTimeout(function () { el.classList.remove("intro"); }, 4200); }
    s.timer = setTimeout(nextCard, ui.first && !REDUCE ? 2600 : 600);
  }
  function storyDestroy() {
    if (!story) return;
    clearTimeout(story.timer);
    clearTimeout(story.release);
    clearTimeout(story.drawT);
    clearTimeout(story.popT);
    cancelAnimationFrame(story.raf);
    cancelAnimationFrame(story.scrollRaf);
    cancelAnimationFrame(story.glideRaf);
    if (story.ro) story.ro.disconnect();
    story = null;
  }

  // Where a map point sits inside the overlay: the same sum the SVG does for viewBox + xMidYMid meet.
  function toScreen(x, y) {
    var W = story.overlay.offsetWidth, H = story.overlay.offsetHeight, vb = story.vb;
    var k = Math.min(W / vb.w, H / vb.h), ox = (W - vb.w * k) / 2 - vb.x * k, oy = (H - vb.h * k) / 2 - vb.y * k;
    return [ox + k * x, oy + k * y];
  }

  // Place pins, nudging apart any that would sit on top of each other (several movements share Delhi, Mumbai and Ranchi).
  function layoutPins() {
    var s = story;
    if (!s) return;
    var pts = PINS.map(function (p) { var q = toScreen(p.x, p.y); return { x: q[0], y: q[1], r: p.r }; });
    for (var it = 0; it < 10; it++) {
      for (var i = 0; i < pts.length; i++) {
        for (var j = i + 1; j < pts.length; j++) {
          var a = pts[i], b = pts[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), need = a.r + b.r + 5;
          if (d >= need) continue;
          if (d < 0.01) { dx = Math.cos(j * 2.4); dy = Math.sin(j * 2.4); d = 1; }
          var push = (need - d) / 2;
          a.x -= dx / d * push; a.y -= dy / d * push; b.x += dx / d * push; b.y += dy / d * push;
        }
      }
    }
    s.screen = pts;
    s.pins.forEach(function (el, i) { el.style.transform = "translate(" + pts[i].x + "px," + pts[i].y + "px)"; });
    s.cards.forEach(placeCard);
    placeTags();
  }

  function setStep(n) {
    var s = story;
    if (!s || s.step === n) return;
    var was = s.step;
    s.step = n;
    s.el.dataset.step = n;
    var lead = LEAD ? LEAD.m.id : null;
    s.svg.querySelectorAll(".st").forEach(function (p) {
      var st = STATS[p.dataset.state], cls = "st";
      if (st && n >= 2) {
        var isLead = st.moves.some(function (m) { return m.id === lead; });
        if (n === 2) cls += isLead ? " focus" : " has";
        else if (n === 3) cls += isLead ? " focus" : "";
        else if (n === 4) cls += st.moves.some(function (m) { return m.coverage.rank; }) ? " hot" : " has";
        else if (n === 5) cls += st.moves.some(function (m) { return m.status === "quiet"; }) ? " calm" : " has";
        else cls += " has";
      }
      if (ui.state && p.dataset.state === ui.state) cls += " sel";
      p.setAttribute("class", cls);
    });
    if (n === 2 || n === 3) s.svg.querySelectorAll(".st.focus").forEach(function (p) { p.parentNode.appendChild(p); }); // drawn last so its edge shows
    // Phones: the border draws itself when the map first appears and undraws if you go back to the header.
    // (Wide screens draw it in step with the scroll, in readScroll.)
    if (NARROW.matches) {
      clearTimeout(s.drawT);
      if (n === 0) s.el.classList.remove("drawn");
      else if (n >= 3) s.el.classList.add("drawn");
      else if (!s.el.classList.contains("drawn")) s.drawT = setTimeout(function () { if (story === s) s.el.classList.add("drawn"); }, REDUCE ? 0 : 2600);
    }
    // The points pop in one after another when they first appear; news cards follow once they have landed.
    if (n === 2 && was < 2) {
      s.el.classList.add("popping", "seen");
      clearTimeout(s.popT);
      s.popT = setTimeout(function () { s.el.classList.remove("popping"); }, 1500);
      clearTimeout(s.timer);
      s.timer = setTimeout(nextCard, REDUCE ? 300 : 1400);
    }
    if (n !== 2) clearCards();
    closeSheet();
    if (n === 5) makeTags(); else clearTags();
    zoomTo(n === 3 && LEAD ? frameFor(LEAD.m) : { x: 0, y: 0, w: MAP.width, h: MAP.height });
  }

  /* ---------- the scroll drives the story ---------- */
  // The step is whichever section's top has passed a line across the screen (the middle on wide screens, just below
  // the pinned map on phones). This reads positions directly, so it works the same inside an embedded frame, after a
  // jump, after a resize and when scrolling back up.
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  // Wide screens. The scroll sets a target for two dials, and the page glides toward it every frame, so a mouse wheel
  // that jumps 100px at a time still gives smooth motion.
  //   a: 0 = the header alone, 1 = the map centred on its own
  //   b: 0 = the map centred, 1 = the map on the right with the protests on it and the news beside it
  function readScroll() {
    var s = story;
    if (!s) return;
    var vh = window.innerHeight, wide = !NARROW.matches, line = vh * (wide ? 0.5 : 0.76), n = 0;
    s.stepEls.forEach(function (el) { if (el.getBoundingClientRect().top <= line) n = +el.dataset.step; });
    s.probe = n;
    if (!wide) { cancelAnimationFrame(s.glideRaf); s.glideRaf = 0; s.glided = false; clearOpening(s); setStep(n); return; }
    s.tgt = {
      a: clamp01(-s.el.getBoundingClientRect().top / (vh * 0.5)),
      // the map slides while the news column climbs from the bottom of the screen to just above the middle
      b: s.news ? clamp01((vh * 1.0 - s.news.getBoundingClientRect().top) / (vh * 0.42)) : 1
    };
    if (!s.glided || REDUCE) { s.cur = { a: s.tgt.a, b: s.tgt.b }; s.glided = true; s.geo = null; }
    if (!s.glideRaf) { s.lastT = 0; s.glideRaf = requestAnimationFrame(glide); }
  }
  function glide(now) {
    var s = story;
    if (!s) return;
    s.glideRaf = 0;
    var dt = s.lastT ? Math.min(64, now - s.lastT) : 16.7, k = 1 - Math.pow(0.8, dt / 16.7), moving = false;
    s.lastT = now;
    ["a", "b"].forEach(function (key) {
      var d = s.tgt[key] - s.cur[key];
      if (Math.abs(d) > 0.0008) { s.cur[key] += d * k; moving = true; } else s.cur[key] = s.tgt[key];
    });
    paintOpening(s);
    if (moving) s.glideRaf = requestAnimationFrame(glide);
  }
  // The map moves as one layer (a transform), never re-laid out, so the browser can keep it smooth. Its resting place is
  // the right-hand box; for the centred view it is shifted and scaled from there.
  function geometry(s) {
    var W = s.stage.clientWidth, H = s.stage.clientHeight, v = window.innerHeight / 100;
    var F = { x: W * 0.46, y: 3 * v, w: W * 0.54, h: H - 6 * v }, C = { x: 0, y: 17 * v, w: W, h: H - 20 * v };
    var kF = Math.min(F.w / MAP.width, F.h / MAP.height), kC = Math.min(C.w / MAP.width, C.h / MAP.height);
    return { W: W, H: H, s: kC / kF, tx: (C.x + C.w / 2) - (F.x + F.w / 2), ty: (C.y + C.h / 2) - (F.y + F.h / 2), v: v };
  }
  function paintOpening(s) {
    var a = s.cur.a, b = s.cur.b, ea = smooth(a), eb = REDUCE ? (b > 0.5 ? 1 : 0) : smooth(b);
    if (!s.geo || s.geo.W !== s.stage.clientWidth || s.geo.H !== s.stage.clientHeight) s.geo = geometry(s);
    var g = s.geo, shown = smooth((a - 0.2) / 0.55);
    s.headIn.style.opacity = 1 - clamp01(a / 0.65);
    s.headIn.style.transform = REDUCE ? "" : "translate3d(0," + (-6 * ea * g.v) + "px,0)";
    var mw = s.mapwrap.style;
    mw.opacity = REDUCE ? (a > 0.4 ? 1 : 0) : shown;
    var rise = REDUCE ? 0 : (1 - shown) * 9 * g.v;
    mw.transform = "translate3d(" + (g.tx * (1 - eb)) + "px," + (g.ty * (1 - eb) + rise) + "px,0) scale(" + (g.s + (1 - g.s) * eb) + ")";
    mw.pointerEvents = a < 0.6 ? "none" : "";
    var capIn = clamp01((a - 0.55) / 0.35) * (1 - clamp01(b / 0.3));
    s.cap.style.opacity = capIn;
    s.cap.style.transform = REDUCE ? "" : "translate3d(0," + ((1 - capIn) * 14) + "px,0)";
    // the news fades in beside the map once the map is clear of its column
    if (s.newsIn) s.newsIn.style.opacity = REDUCE ? (b > 0.5 ? 1 : 0) : smooth((b - 0.62) / 0.33);
    // the border draws as the map arrives
    var drawn = REDUCE || a >= 0.999;
    s.el.classList.toggle("drawn", drawn);
    s.outline.style.strokeDashoffset = drawn ? "" : String(s.len * (1 - smooth((a - 0.25) / 0.75)));
    // the protests appear on the map as it settles into place
    var n = s.probe;
    if (n < 2 && b > 0.8) n = 2;
    setStep(n);
    if (n >= 2 && eb > 0.999 && !s.settled) { s.settled = true; layoutPins(); } else if (eb < 0.999) s.settled = false;
  }
  function clearOpening(s) {
    [s.headIn, s.mapwrap, s.cap, s.newsIn].forEach(function (el) { if (el) el.removeAttribute("style"); });
    s.outline.style.strokeDashoffset = "";
  }
  window.addEventListener("scroll", function () {
    if (story && !story.scrollRaf) story.scrollRaf = requestAnimationFrame(function () { if (story) { story.scrollRaf = 0; readScroll(); } });
  }, { passive: true });

  // a viewBox that frames a movement's places, matched to the stage's shape
  function frameFor(m) {
    var xs = m._pins.map(function (i) { return PINS[i].x; }), ys = m._pins.map(function (i) { return PINS[i].y; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var r = { width: story.overlay.offsetWidth, height: story.overlay.offsetHeight };
    if (r.width < 10 || r.height < 10) return { x: 0, y: 0, w: MAP.width, h: MAP.height };
    var aspect = r.width / r.height;
    var w = Math.max(x1 - x0 + 260, 300), h = Math.max(y1 - y0 + 260, 300);
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  }

  function zoomTo(t) {
    var s = story, from = { x: s.vb.x, y: s.vb.y, w: s.vb.w, h: s.vb.h };
    cancelAnimationFrame(s.raf);
    var t0 = performance.now(), dur = REDUCE ? 0 : 1150;
    function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
    function frame(now) {
      if (story !== s) return;
      var k = dur ? Math.min(1, (now - t0) / dur) : 1, e = ease(k);
      s.vb = { x: from.x + (t.x - from.x) * e, y: from.y + (t.y - from.y) * e, w: from.w + (t.w - from.w) * e, h: from.h + (t.h - from.h) * e };
      s.svg.setAttribute("viewBox", s.vb.x + " " + s.vb.y + " " + s.vb.w + " " + s.vb.h);
      layoutPins();
      if (k < 1) s.raf = requestAnimationFrame(frame);
    }
    s.raf = requestAnimationFrame(frame);
  }

  /* news cards that pop up where the story happened */
  var TONE = { active: "hot", quiet: "calm", ended: "cold" };
  function overlaps(a, b, m) { return a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y; }
  function pinBox(q) { return { x: q.x - q.r, y: q.y - q.r, w: 2 * q.r, h: 2 * q.r }; }
  function pinHidden(i) { return story.step < 2 || (story.step === 3 && !(LEAD && PINS[i].m === LEAD.m)); }
  var NARROW = window.matchMedia("(max-width: 900px)"); // phones: the map is too small for cards over it

  function nextCard() {
    var s = story;
    if (!s) return;
    s.timer = setTimeout(nextCard, 2700);
    if (s.step !== 2 || s.paused || s.held || document.hidden || NARROW.matches || !QUEUE.length) return;
    var item = QUEUE[s.idx % QUEUE.length];
    s.idx++;
    var at = pinFor(item.m, item.r);
    if (at.i === undefined) return;
    var max = s.overlay.clientWidth < 520 ? 1 : 2;
    while (s.cards.length >= max) dropCard(s.cards[0]);
    showCard(item, at, false);
  }
  function showCard(item, at, held) {
    var s = story, m = item.m, pinIndex = at.i;
    var el = document.createElement("article");
    el.className = "card" + (item.lead ? " lead" : "") + (held ? " held" : "");
    el.style.setProperty("--pc", "var(--" + TONE[m.status] + ")");
    el.dataset.go = m.id;
    el.dataset.at = pinIndex;
    el.dataset.anchor = "r-" + item.r.id;
    el.innerHTML = (item.lead ? '<p class="c-lead">Leading the news</p>' : "") + '<p class="c-top"><span>' + esc(item.r.outlet) + '</span><time datetime="' + item.r.date + '">' + fmt(item.r.date, { short: true, noYear: sameYear(item.r.date) }) + '</time></p>' +
      '<p class="c-mv"><i></i>' + esc(m._short) + (at.named ? ', ' + esc(PINS[pinIndex].name) : "") + '</p><p class="c-sum">' + esc(item.r.summary) + '</p>' +
      (held ? '<p class="c-foot"><span>' + STATUS[m.status] + ', ' + plural(m.report_count, "report") + '</span><b>Open the file</b></p>' : "");
    var wire = document.createElement("span");
    wire.className = "wire";
    s.overlay.appendChild(wire);
    s.overlay.appendChild(el);
    var card = { el: el, wire: wire, pin: pinIndex, held: held };
    s.pins[pinIndex].classList.add("has-card");
    s.cards.push(card);
    placeCard(card);
    var pinEl = s.pins[pinIndex];
    requestAnimationFrame(function () { el.classList.add("in"); if (wire) wire.classList.add("in"); if (!held) pinEl.classList.add("ping"); });
    if (!held) {
      setTimeout(function () { pinEl.classList.remove("ping"); }, 700);
      card.expire = setTimeout(function () { expire(card); }, 5600);
    }
    return card;
  }
  // a card stays up while the pointer is on it
  function expire(card) {
    if (card.el.matches(":hover")) { card.expire = setTimeout(function () { expire(card); }, 1200); return; }
    dropCard(card);
  }

  // Tries spots all round the pin, near then farther out, and keeps the one that covers the fewest other pins,
  // cards and labels. A card never covers its own pin or another card if any spot avoids it.
  function placeCard(card) {
    var s = story, p = s.screen[card.pin];
    if (!p) return;
    var W = s.overlay.clientWidth, H = s.overlay.clientHeight, cw = card.el.offsetWidth, ch = card.el.offsetHeight;
    var others = s.cards.filter(function (c) { return c !== card && c.rect; }).map(function (c) { return c.rect; });
    var tags = s.tags.map(function (t) { return t.rect; }).filter(Boolean);
    var away = p.x > W * 0.55 ? 0 : 1, best = null; // side 0 = right of the pin, 1 = left, 2 = centred
    // Candidate spots: rings around the pin, plus a grid over the whole map so a card can go out over the sea when
    // the land near its pin is crowded. Distance costs a little; covering a pin costs a lot more.
    var cands = [];
    [24, 56, 96, 140].forEach(function (gap) {
      var d = gap * 0.75;
      cands.push([p.x + gap, p.y - ch / 2, 0], [p.x - gap - cw, p.y - ch / 2, 1], [p.x + d, p.y - ch - d, 0], [p.x - d - cw, p.y - ch - d, 1],
        [p.x + d, p.y + d, 0], [p.x - d - cw, p.y + d, 1], [p.x - cw / 2, p.y - ch - gap, 2], [p.x - cw / 2, p.y + gap, 2]);
    });
    for (var gx = 0; gx <= 6; gx++) for (var gy = 0; gy <= 6; gy++) cands.push([8 + (W - cw - 16) * gx / 6, 8 + (H - ch - 16) * gy / 6, 3]);
    cands.forEach(function (c, ci) {
        var r = { x: Math.max(8, Math.min(W - cw - 8, c[0])), y: Math.max(8, Math.min(H - ch - 8, c[1])), w: cw, h: ch };
        var nx = Math.max(r.x, Math.min(r.x + cw, p.x)), ny = Math.max(r.y, Math.min(r.y + ch, p.y));
        var cost = Math.hypot(nx - p.x, ny - p.y) / 15 + ci * 0.01 + (c[2] === away ? 1.5 : 0);
        if (overlaps(r, pinBox(p), 6)) cost += 1000;
        others.forEach(function (o) { if (overlaps(r, o, 10)) cost += 400; });
        tags.forEach(function (o) { if (overlaps(r, o, 4)) cost += 30; });
        s.screen.forEach(function (q, qi) {
          if (qi === card.pin || pinHidden(qi) || !overlaps(r, pinBox(q), 4)) return;
          cost += s.pins[qi].classList.contains("is-lead") ? 45 : 20;
        });
        if (!best || cost < best.cost) best = { r: r, cost: cost };
    });
    var b = best.r;
    card.rect = b;
    card.el.style.transform = "translate(" + b.x + "px," + b.y + "px)";
    card.el.style.setProperty("--ox", (p.x < b.x ? 0 : p.x > b.x + cw ? cw : p.x - b.x) + "px");
    var tx = Math.max(b.x, Math.min(b.x + cw, p.x)), ty = Math.max(b.y, Math.min(b.y + ch, p.y));
    var len = Math.hypot(tx - p.x, ty - p.y), ang = Math.atan2(ty - p.y, tx - p.x) * 180 / Math.PI;
    card.wire.style.width = Math.max(0, len - p.r) + "px";
    card.wire.style.transform = "translate(" + p.x + "px," + p.y + "px) rotate(" + ang + "deg) translateX(" + p.r + "px)";
  }
  function dropCard(card) {
    var s = story;
    if (!s) return;
    clearTimeout(card.expire);
    if (s.held === card) s.held = null;
    s.cards = s.cards.filter(function (c) { return c !== card; });
    card.el.classList.remove("in"); card.el.classList.add("out"); if (card.wire) card.wire.classList.remove("in");
    if (!s.cards.some(function (c) { return c.pin === card.pin; })) s.pins[card.pin].classList.remove("has-card");
    setTimeout(function () { card.el.remove(); if (card.wire) card.wire.remove(); }, 450);
  }
  function clearCards() { if (story) { clearTimeout(story.release); story.cards.slice().forEach(dropCard); story.held = null; } }

  // Pointing at a pin (or tabbing to it) swaps the passing cards for that place's newest report, held until you move away.
  function reportAt(m, i) {
    var recs = m.reports.filter(onRecord), keys = PINS[i].keys;
    var here = recs.filter(function (r) { var t = r.summary.toLowerCase(); return keys.some(function (k) { return t.indexOf(k) > -1; }); });
    if (here.length) return { r: here[0], named: true };
    return { r: recs.filter(function (r) { return r.read; })[0] || recs[0] || m.reports[0], named: m._pins.length === 1 };
  }
  function holdPin(i) {
    var s = story;
    if (!s || !s.pins[i] || pinHidden(i) || NARROW.matches) return;
    clearTimeout(s.release);
    if (s.held && s.held.pin === i) return;
    s.cards.slice().forEach(dropCard);
    var m = PINS[i].m, at = reportAt(m, i);
    s.held = showCard({ r: at.r, m: m, lead: !!LEAD && m === LEAD.m }, { i: i, named: at.named }, true);
  }
  function holdMovement(m) {
    if (!m || !m._pins.length) return;
    var recs = m.reports.filter(onRecord), r = recs.filter(function (x) { return x.read; })[0] || recs[0] || m.reports[0];
    holdPin(pinFor(m, r).i);
  }
  function releasePin(now) {
    var s = story;
    if (!s || !s.held) return;
    clearTimeout(s.release);
    s.release = setTimeout(function () {
      if (story !== s || !s.held || s.held.el.matches(":hover")) return;
      dropCard(s.held);
    }, now ? 0 : 280);
  }

  /* labels for quiet movements (step 3) */
  function makeTags() {
    var s = story;
    clearTags();
    // Label only the six most recently reported quiet movements, so the map stays readable; the list beside it has them all.
    M.filter(function (m) { return m.status === "quiet"; }).slice(0, 6).forEach(function (m) {
      var el = document.createElement("span");
      el.className = "tag";
      el.innerHTML = esc(m._short) + ' <b>' + (m.latest_report ? fmt(m.latest_report, { short: true, noYear: sameYear(m.latest_report) }) : "no reports yet") + '</b>';
      s.overlay.appendChild(el);
      s.tags.push({ el: el, pin: m._pins[0], m: m.id });
    });
    placeTags();
    requestAnimationFrame(function () { s.tags.forEach(function (t) { t.el.classList.add("in"); }); });
  }
  // each label goes on whichever side of its pin covers fewer other pins, stepping down past labels already placed
  function placeTags() {
    var s = story;
    if (!s || !s.tags.length) return;
    var W = s.overlay.clientWidth, placed = [];
    s.tags.slice().sort(function (a, b) { return s.screen[a.pin].y - s.screen[b.pin].y; }).forEach(function (t) {
      var p = s.screen[t.pin], w = t.el.offsetWidth, h = t.el.offsetHeight, best = null;
      [[p.x + p.r + 8, p.y - h / 2], [p.x - p.r - 8 - w, p.y - h / 2], [p.x - w / 2, p.y - p.r - 8 - h], [p.x - w / 2, p.y + p.r + 8],
       [p.x + p.r + 6, p.y - p.r - 6 - h], [p.x + p.r + 6, p.y + p.r + 6], [p.x - p.r - 6 - w, p.y - p.r - 6 - h], [p.x - p.r - 6 - w, p.y + p.r + 6]].forEach(function (c0, side) {
        var r = { x: Math.max(4, Math.min(W - w - 4, c0[0])), y: c0[1], w: w, h: h };
        for (var k = 0; k < 12 && placed.some(function (o) { return overlaps(r, o, 4); }); k++) r.y += h + 4;
        var cost = side * 0.5 + Math.abs(r.y - c0[1]) / 20;
        s.screen.forEach(function (q, qi) {
          if (!overlaps(r, pinBox(q), 3)) return;
          cost += qi === t.pin ? 100 : PINS[qi].m.status === "quiet" ? 10 : 2;
        });
        if (!best || cost < best.cost) best = { r: r, cost: cost };
      });
      placed.push(best.r);
      t.rect = best.r;
      t.el.style.transform = "translate(" + best.r.x + "px," + best.r.y + "px)";
    });
  }
  function focusTag(id) {
    var s = story;
    if (!s || s.step !== 5) return;
    s.tags = s.tags.filter(function (t) { if (t.temp && t.m !== id) { t.el.remove(); return false; } return true; });
    var m = id && byId[id];
    if (m && m.status === "quiet" && !s.tags.some(function (t) { return t.m === id; })) {
      var el = document.createElement("span");
      el.className = "tag in";
      el.innerHTML = esc(m._short) + ' <b>' + (m.latest_report ? fmt(m.latest_report, { short: true, noYear: sameYear(m.latest_report) }) : "no reports yet") + '</b>';
      s.overlay.appendChild(el);
      s.tags.push({ el: el, pin: m._pins[0], m: id, temp: true });
    }
    s.tags.forEach(function (t) { t.el.classList.toggle("lit", t.m === id); });
    placeTags();
  }
  function clearTags() {
    if (!story) return;
    story.tags.forEach(function (t) { var el = t.el; el.classList.remove("in"); setTimeout(function () { el.remove(); }, 500); });
    story.tags = [];
  }

  /* ---------- ledger ---------- */
  function axis(dom) {
    var narrow = window.innerWidth < 760, step = Math.ceil(dom.ticks.length / (narrow ? 4 : 8));
    var h = dom.ticks.map(function (tk, i) {
      var x = pos(tk.t, dom);
      if (x > 93 || i % step) return "";
      return '<span class="m" style="left:' + x + '%">' + tk.label + '</span>';
    }).join("");
    return h + '<span class="td" style="left:' + pos(TODAY, dom) + '%">Today, ' + fmt(D.today, { short: true, noYear: true }) + '</span>';
  }
  function gridHtml(dom) {
    return dom.ticks.map(function (tk) { return '<span class="gl" style="left:' + pos(tk.t, dom) + '%"></span>'; }).join("") +
      '<span class="tl" style="left:' + pos(TODAY, dom) + '%"></span>';
  }
  function track(m, big) {
    var barEnd = Math.max(m._end, m._start);
    var h = '<span class="bar b-' + m.status + '" data-a="' + m._start + '" data-b="' + barEnd + '"></span>';
    if (m.status === "active" && TODAY > barEnd) h += '<span class="ongoing" data-a="' + barEnd + '" data-b="' + TODAY + '"></span>';
    var byDay = {};
    m.reports.forEach(function (r) { (byDay[r.date] = byDay[r.date] || []).push(r.outlet); });
    Object.keys(byDay).forEach(function (d) {
      var outs = byDay[d], sz = (big ? 13 : 9) + Math.min(outs.length - 1, 3) * 2;
      h += '<span class="dot" data-t="' + ms(d) + '" style="--sz:' + sz + 'px" data-tip="' + esc(fmt(d) + ": " + list(outs)) + '"></span>';
    });
    var last = m.ended ? "Ended " + fmt(m.ended, { short: true }) : lastSeen(m);
    h += '<span class="before" data-b="' + barEnd + '">' + last + '</span>';
    return '<div class="track' + (big ? " big" : "") + '" style="view-transition-name:k-' + m.id + '" aria-hidden="true"><div class="grid-layer"></div>' + h + '</div>';
  }
  // Positions every mark for a time domain; called again when the range changes so marks slide rather than redraw.
  function layout(el, dom) {
    el.querySelector(".grid-layer").innerHTML = gridHtml(dom);
    el.querySelectorAll("[data-a]").forEach(function (b) {
      var a0 = +b.dataset.a, b0 = +b.dataset.b, off = b0 < dom.start;
      var x = pos(a0, dom), w = Math.max(pos(b0, dom) - x, b.classList.contains("bar") ? 0.8 : 0);
      b.style.left = x + "%"; b.style.width = (off ? 0 : w) + "%";
      b.classList.toggle("off", off);
      b.classList.toggle("early", a0 < dom.start && !off);
    });
    el.querySelectorAll(".dot").forEach(function (d) {
      var t = +d.dataset.t;
      d.style.left = pos(t, dom) + "%";
      d.classList.toggle("off", t < dom.start);
    });
    var bf = el.querySelector(".before");
    if (bf) bf.classList.toggle("on", +bf.dataset.b < dom.start);
  }
  function layoutAll() {
    var rows = document.getElementById("rows");
    if (rows) {
      var dom = domain(ui.range);
      rows.querySelectorAll(".track").forEach(function (t) { layout(t, dom); });
      var ax = document.getElementById("axis");
      if (ax) ax.innerHTML = axis(dom);
    }
    var big = app.querySelector(".mtrack");
    if (big && ui.view === "movement") {
      var md = domainFor(byId[ui.id]);
      layout(big.querySelector(".track"), md);
      big.querySelector(".axis-track").innerHTML = axis(md);
    }
  }
  function rowMeta(m) {
    var when = m.status === "ended" ? "Ended " + fmt(m.ended, { short: true }) : lastSeen(m, "Latest report");
    return '<b>' + STATUS[m.status] + '.</b> ' + esc(m.cause) + ', ' + esc(m.places) + '. ' + when + '.';
  }
  function row(m, i) {
    return '<li class="row cols" data-id="' + m.id + '" style="view-transition-name:r-' + m.id + ';--i:' + i + '">' +
      '<div class="row-text">' + glyph(m.status) + '<h3><a href="#' + m.id + '" data-go="' + m.id + '" style="view-transition-name:t-' + m.id + '">' + esc(m.name) + '</a></h3>' +
      '<p class="row-meta">' + rowMeta(m) + '</p></div>' + track(m, false) +
      '<span class="count" aria-label="' + plural(m.report_count, "report") + '">' + m.report_count + '</span></li>';
  }
  function rowsHtml() {
    var v = visible();
    if (!v.length) return '<li class="empty"><p>No movement matches these filters.</p><button type="button" class="linkbtn" data-clear>Clear the filters</button></li>';
    return v.map(row).join("");
  }
  function noteHtml() {
    var v = visible().length, parts = [];
    if (ui.state) parts.push("in " + esc(ui.state));
    if (ui.cause) parts.push("about " + esc(ui.cause.toLowerCase()));
    if (ui.status) parts.push("that are " + ui.status);
    if (ui.q) parts.push("matching “" + esc(ui.q) + "”");
    if (!parts.length) return "";
    return 'Showing ' + plural(v, "movement") + ' ' + parts.join(", ") + '. <button type="button" class="linkbtn" data-clear>Show all movements</button>';
  }

  function home() {
    var seg = ["", "active", "quiet", "ended"].map(function (s) {
      return '<button type="button" role="radio" data-status="' + s + '" aria-checked="' + (ui.status === s) + '">' + (s ? STATUS[s] : "All") + ' <b>' + COUNTS[s] + '</b></button>';
    }).join("");
    var causes = CAUSES.map(function (c) { return '<button type="button" class="cause" data-cause="' + esc(c) + '" aria-pressed="' + (ui.cause === c) + '">' + esc(c) + '</button>'; }).join("");
    var states = '<label class="statesel"><span class="vh">State</span><select id="statesel"><option value="">All states</option>' +
      STATE_NAMES.map(function (s) { return '<option' + (ui.state === s ? " selected" : "") + '>' + esc(s) + '</option>'; }).join("") + '</select></label>';
    var sites = (D.directory || []).map(function (s) {
      return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a><span class="kind">' + esc(s.kind) + '</span><p>' + esc(s.about) + '</p></li>';
    }).join("");
    return storyHtml() + '<main>' + waiting() + issues() +
      '<section class="ledger gut" id="ledger" aria-labelledby="ledger-h"><div class="wrap">' +
      '<div class="ledger-head"><h2 id="ledger-h">Every movement on one timeline</h2>' +
      '<p class="ledger-sub">Each line runs from the day a movement began to its latest report. Movements with recent reports come first. Select one to read its full file.</p>' +
      '<div class="controls"><div class="seg" role="radiogroup" aria-label="Status">' + seg + '<span class="seg-ind" aria-hidden="true"></span></div>' +
      '<div class="causes" role="group" aria-label="Issue">' + causes + '</div>' + states +
      '<label class="search"><span class="vh">Search movements</span><input id="q" type="search" autocomplete="off" placeholder="Search a place, group or outlet" value="' + esc(ui.q) + '"></label></div>' +
      '<div class="scalebar"><div class="seg range" role="radiogroup" aria-label="Time range">' + RANGES.map(function (r) {
        return '<button type="button" role="radio" data-range="' + r[0] + '" aria-checked="' + (ui.range === r[0]) + '">' + r[1] + '</button>';
      }).join("") + '<span class="seg-ind" aria-hidden="true"></span></div>' +
      '<p class="legend"><span><i class="lg-bar" style="background:var(--active)"></i>Active</span><span><i class="lg-bar" style="background:var(--quiet)"></i>Quiet</span>' +
      '<span><i class="lg-bar" style="box-shadow:inset 0 0 0 1.5px var(--ended)"></i>Ended</span><span><i class="lg-dot"></i>A report (larger when several share a day)</span>' +
      '<span><i class="lg-dash"></i>Still going</span></p></div>' +
      '<p class="fnote" id="fnote" aria-live="polite">' + noteHtml() + '</p></div>' +
      '<div class="axis cols"><span class="hd">Movement</span><div class="axis-track" id="axis" aria-hidden="true"></div><span class="hd n">Reports</span></div>' +
      '<ol class="rows" id="rows">' + rowsHtml() + '</ol></div></section>' +
      '<section class="dir gut" aria-labelledby="dir-h"><div class="wrap"><h2 id="dir-h">Archives that go deeper</h2>' +
      '<p>Some movements have their own archive or running record. We link to them instead of copying them.</p><ul class="sites">' + sites + '</ul></div></section></main>';
  }

  /* ---------- stories waiting for review (headlines and links only) ---------- */
  function waiting() {
    var w = D.waiting || [];
    if (!w.length) return "";
    return '<section class="waiting gut" aria-labelledby="wait-h"><div class="wrap"><div class="waiting-head">' +
      '<h2 id="wait-h">Waiting for review</h2><p>Stories the collector has found that an editor has not checked yet. The headlines are the outlets\u2019 own; nothing is summarised or added to a movement until it is approved.</p></div>' +
      '<ul class="wlist">' + w.map(function (x) {
        var m = x.movement && byId[x.movement];
        var hi = /[\u0900-\u097F]/.test(x.title) ? ' lang="hi"' : "";
        return '<li><a class="w-link" href="' + esc(x.url) + '" target="_blank" rel="noopener"><span class="w-src">' + esc(x.outlet) +
          (x.published ? ', ' + fmt(x.published, { short: true, noYear: sameYear(x.published) }) : "") + '</span><span class="w-title"' + hi + '>' + esc(x.title) + '</span></a>' +
          (m ? '<a class="w-mv" href="#' + m.id + '" data-go="' + m.id + '">Probably about ' + esc(m._short) + '</a>' : '<span class="w-mv none">Not matched to a movement yet</span>') + '</li>';
      }).join("") + '</ul></div></section>';
  }

  /* ---------- what the protests are about ---------- */
  var CHEVRON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function issues() {
    var items = M.filter(function (m) { return m.context; });
    if (!items.length) return "";
    return '<section class="issues gut" aria-labelledby="issues-h"><div class="wrap"><div class="issues-head"><div>' +
      '<h2 id="issues-h">What the protests are about</h2><p>The issue behind each movement in a few lines. Open one for the full background, what it changes for people, and the sources.</p></div>' +
      '<div class="gal-nav"><button type="button" class="gal-btn prev" data-gal="-1" aria-label="Previous">' + CHEVRON + '</button>' +
      '<button type="button" class="gal-btn" data-gal="1" aria-label="Next">' + CHEVRON + '</button></div></div>' +
      '<ul class="gallery" id="gallery">' + items.map(function (m) {
        return '<li class="issue"><a href="#' + m.id + '" data-go="' + m.id + '" data-anchor="background">' +
          '<span class="issue-mv">' + glyph(m.status) + esc(m._short) + '</span><h3>' + esc(m.context.question) + '</h3>' +
          '<p>' + esc(m.context.short) + '</p><span class="issue-more">Read the background</span></a></li>';
      }).join("") + '</ul></div></section>';
  }

  /* ---------- movement page ---------- */
  function background(m) {
    var c = m.context;
    if (!c) return "";
    return '<section class="bg" id="background" aria-labelledby="bg-h"><div class="bg-head"><p class="bg-label">Background</p>' +
      '<h2 id="bg-h">' + esc(c.question) + '</h2><p class="bg-short">' + esc(c.short) + '</p></div>' +
      '<div class="bg-grid"><div class="bg-text">' + c.explainer.map(function (x) { return '<p>' + esc(x) + '</p>'; }).join("") + '</div>' +
      '<div class="bg-impact"><h3>What it changes</h3><ul>' + c.impact.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul></div></div>' +
      '<div class="bg-src"><h3>Sources for this background</h3><ol>' + c.sources.map(function (x) {
        return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a></li>';
      }).join("") + '</ol><p>Last checked ' + fmt(c.updated) + '. Contested figures and claims are attributed to whoever made them.</p></div></section>';
  }
  function miniMap(m) {
    var on = function (n) { return m.states.indexOf(n) > -1 ? "on" : ""; };
    var dots = m._locs.map(function (l) {
      return '<circle cx="' + l.xy[0].toFixed(1) + '" cy="' + l.xy[1].toFixed(1) + '" r="13" fill="var(--' + m.status + ')"></circle>';
    }).join("");
    return '<figure class="mini"><svg viewBox="0 0 ' + MAP.width + ' ' + MAP.height + '" role="img" aria-label="Map of India marking ' + esc(list(m._locs.map(function (l) { return l.name; }))) + '">' +
      statesSvg(on) + dots + '</svg><figcaption>' + esc(list(m._locs.map(function (l) { return l.name; }))) + '</figcaption></figure>';
  }
  function movement(m) {
    var idx = M.indexOf(m), prev = M[idx - 1], next = M[idx + 1];
    var demands = m.demands.replace(/\.$/, "").split(/;\s*/).filter(Boolean).map(function (d) {
      return "<li>" + esc(d.charAt(0).toUpperCase() + d.slice(1)) + "</li>";
    }).join("");
    var groups = [], cur = null;
    m.reports.forEach(function (r) {
      var key = r.date.slice(0, 7);
      if (!cur || cur.key !== key) { cur = { key: key, items: [] }; groups.push(cur); }
      cur.items.push(r);
    });
    var reps = groups.map(function (g) {
      return '<h3 class="month">' + fmt(g.key) + '</h3><ul class="reps">' + g.items.map(function (r) {
        return '<li class="rep" id="r-' + esc(r.id) + '"><time datetime="' + r.date + '">' + fmt(r.date, { short: true, noYear: true }) + '</time><div>' +
          '<p class="rep-src"><a class="out" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.outlet) + '</a><span class="kind">' + esc(r.kind) + '</span>' +
          (r.read ? "" : '<span class="flag" tabindex="0" data-tip="This summary rests on the headline or a snippet. The full article has not been read yet.">Headline only</span>') +
          (r.drafted_by === "ai" ? '<span class="aitag" tabindex="0" data-tip="Drafted by the AI assistant from the article, then checked and approved by an editor.">AI-drafted, editor-approved</span>' : "") +
          (r.archive_url ? '<a class="arch" href="' + esc(r.archive_url) + '" target="_blank" rel="noopener">Archived copy</a>' : "") +
          '</p><p class="rep-sum">' + esc(r.summary) + '</p></div></li>';
      }).join("") + '</ul>';
    }).join("");
    var base = D.config.base_url ? D.config.base_url.replace(/\/$/, "") + "/#" + m.id : "";
    var cite = 'Andolan Index, “' + m.name + '”, accessed ' + fmt(D.today) + (base ? ", " + base : "") + ".";
    var facts = [
      ["Status", STATUS[m.status] + ", " + STATUS_NOTE[m.status]],
      ["Began", fmt(m.started)],
      m.ended ? ["Ended", fmt(m.ended)] : null,
      ["Latest report", m.latest_report ? fmt(m.latest_report) : "None yet"],
      ["Reports", plural(m.report_count, "report") + " from " + plural(m._outlets, "outlet")],
      ["Issue", m.cause]
    ].filter(Boolean).map(function (f) { return "<dt>" + f[0] + "</dt><dd>" + esc(f[1]) + "</dd>"; }).join("");
    return '<main class="gut"><article class="mview wrap">' +

      '<header class="mhead"><p class="mstatus">' + glyph(m.status) + '<b>' + STATUS[m.status] + '</b> ' + esc(m.places) + '</p>' +
      '<h1 style="view-transition-name:t-' + m.id + '">' + esc(m.name) + '</h1>' +
      (m.aliases && m.aliases.length ? '<p class="aka">Also reported as ' + esc(list(m.aliases)) + '.</p>' : "") +
      (m.context ? '<a class="jump" href="#background" data-jump="background">' + esc(m.context.question) + '</a>' : "") + '</header>' +
      '<div class="mtrack"><div class="axis-track" aria-hidden="true"></div>' + track(m, true) + '</div>' +
      '<div class="mgrid"><div class="mmain">' +
      '<section><h2>What it is about</h2><p class="about-p">' + esc(m.about) + '</p></section>' +
      '<section><h2>Demands</h2><ul class="demands">' + demands + '</ul></section>' +
      '<section><h2>' + plural(m.report_count, "report") + ', newest first</h2>' + reps + '</section></div>' +
      '<aside class="mside"><dl class="facts">' + facts + '</dl>' + miniMap(m) +
      '<details class="cite"><summary>Cite this page</summary><div class="cite-body"><p class="ref" id="cite-ref">' + esc(cite) + '</p>' +
      '<p><button type="button" class="btn" data-copy="cite-ref">Copy citation</button></p>' +
      '<p>Free to reuse with credit (CC BY 4.0): <a href="data/m/' + m.id + '.json" target="_blank" rel="noopener">this movement as JSON</a> or <a href="data/reports.csv" target="_blank" rel="noopener">every report as CSV</a>.</p></div></details></aside></div>' +
      background(m) +
      '<nav class="pager" aria-label="Other movements">' +
      (prev ? '<a href="#' + prev.id + '" data-go="' + prev.id + '"><span>Previous</span><strong>' + esc(prev.name) + '</strong></a>' : "<span></span>") +
      (next ? '<a class="next" href="#' + next.id + '" data-go="' + next.id + '"><span>Next</span><strong>' + esc(next.name) + '</strong></a>' : "<span></span>") +
      '</nav></article></main>';
  }

  function about() {
    var d = D.config.active_days;
    var sample = null;
    M.some(function (m) { return m.reports.some(function (r) { if (r.read && r.kind === "news") { sample = r; return true; } return false; }); });
    var aiName = D.ai && D.ai.model ? D.ai.model : "an AI model";
    var STEPS = [
      ["Find", "Every six hours a scheduled job reads the news feeds of outlets such as The Hindu, The Indian Express, The Wire and Scroll, and keeps stories that look like protest coverage.", "python -m andolan collect", "data/inbox/"],
      ["Draft", "An AI assistant (" + aiName + ") reads each story, decides which movement it belongs to, drafts a summary with the exact quotes behind every fact, checks those quotes against the article and scores how important the story is.", "python -m andolan ai", "config/ai.json"],
      ["Check", "An editor reads the story and the draft, then approves it, corrects it or rejects it. Stories that are not about a protest are never suggested again.", "python -m andolan curate promote", "data/rejected.txt"],
      ["Store", "Each movement is one small file and each report is another, kept in a public Git repository. Every change is a reviewed commit, so the history of every entry is open to anyone.", "data/movements/*.json", "data/reports/2026/10/*.json"],
      ["Publish", "When a change is approved, the site is rebuilt: this one page with every movement and report built in, plus downloads in JSON, CSV and a feed. It also rebuilds daily so Active and Quiet stay current.", "python -m andolan build", "site/"],
      ["Show", "Your browser reads the data built into the page and draws everything from it: the map, the news cards, the timeline and each movement\u2019s file. Nothing is fetched while you browse, so pages open instantly.", "site_src/app.js", "index.html"]
    ];
    var flow = '<figure class="flow" aria-labelledby="flow-cap"><ol>' + STEPS.map(function (st, i) {
      return '<li><span class="flow-n">' + (i + 1) + '</span><h3>' + st[0] + '</h3><p>' + esc(st[1]) + '</p><p class="flow-code"><code>' + esc(st[2]) + '</code><code>' + esc(st[3]) + '</code></p></li>';
    }).join("") + '</ol><figcaption id="flow-cap">How a news report travels from an outlet\u2019s website to this page. Steps 1, 2, 5 and 6 run on their own. An editor does step 3 and approves every change in step 4.</figcaption></figure>';
    return '<main class="gut"><article class="aboutpage wrap"><div class="prose">' +
      '<h1>How this works</h1>' +
      '<p>Andolan Index follows protest movements across India and keeps the reporting on each one in a single place, so anyone can see what is happening now and still find it after the news moves on.</p>' +
      '<h2>Where the reports come from, where they are kept and how they reach you</h2></div>' + flow +
      '<div class="prose">' +
      (sample ? '<h2>What a stored report looks like</h2><p>This is a real entry from the archive, exactly as it is stored. The summary is ours; the article stays on the outlet\u2019s site and is only linked.</p><pre class="sample"><code>' + esc(JSON.stringify(sample, null, 2)) + '</code></pre>' : "") +
      '<h2>What a movement file holds</h2><p>A name, the places it covers with map coordinates, when it began, what it is about, what it demands, and a background section that explains the issue behind it and what it changes for people, with its sources. Each article, post or reference page about it is filed underneath as a report: a link, the outlet, the date and one or two sentences in our own words. We never copy article text.</p>' +
      '<h2>The AI assistant</h2><p>The assistant does the reading and sorting so editors can spend their time checking. It runs ' +
      (D.ai && D.ai.provider === "ollama" ? 'an open model, ' + esc(aiName) + ', on the machine that runs the schedule, so it needs no outside AI service.' : D.ai && D.ai.provider === "anthropic" ? esc(aiName) + ' through the Anthropic API.' : 'when it is switched on in the settings.') +
      ' It is told to use only what the article says, to attribute contested claims and not to name private individuals. Its draft is then checked by code: every quote must appear in the article, and every number and name in the summary must too. Drafts that fail are flagged for the editor.</p>' +
      '<p>Importance is a fixed formula, not the model\u2019s opinion: 10 points for each outlet covering the movement in the last 48 hours (up to 40), up to 20 for coverage growing week on week, and points for what the article reports (deaths 15, detentions 10, internet shutdowns 10, injuries 5, court orders 5, spread to a new city 5, up to 40). Every score comes with one line saying why.</p>' +
      '<p>Nothing the assistant writes appears here until an editor approves it. ' + (D.ai && D.ai.autonomy === "links" ? 'Headlines of stories still waiting for review can appear on the front page, labelled as such, linking to the outlet.' : '') + ' Reports it drafted carry an \u201cAI-drafted, editor-approved\u201d label.</p>' +
      '<h2 id="lead-rule">How the lead story is chosen</h2><p>The front page leads with the protest that the most different outlets reported on in the past ' + (LEAD ? LEAD.days : 7) + ' days. Ties go to the one with more reports, then to the one reported most recently. Copies of one agency story, such as a PTI or Bloomberg report carried by another paper, count once. Only journalism counts: news reports, opinion, explainers, fact-checks and roundups, not reference pages such as Wikipedia.</p>' +
      '<p>The article shown with it is that protest\u2019s newest report. When several appeared the same day, one we have read in full comes before a headline-only summary, a news report before commentary, and a report of detentions, injuries, deaths, shutdowns or court orders before one without. The choice is recalculated every time the site is rebuilt, at least once a day, so the lead changes as the news does. It counts approved reports only, never stories still waiting for review.</p>' +
      '<h2>Keeping links alive</h2><p>After a report is stored, another script asks the Internet Archive to keep a copy of the article, so the link still works if the outlet moves or deletes it.</p>' +
      '<h2>Active, quiet and ended</h2><p>Active means at least one report from the last ' + d + ' days. Quiet means nothing newer has been found, which is not the same as over. Ended is set by hand when a protest is called off or resolved.</p>' +
      '<h2>Headline only</h2><p>Some summaries rest on a headline or a snippet because the full article could not be read. They carry a "Headline only" mark until someone reads the article.</p>' +
      '<h2>Disputed claims</h2><p>Casualty figures, crowd sizes and accounts of clashes often differ between protesters, police and outlets. Summaries say who made each claim. Fact-checks are filed under the movement they concern.</p>' +
      '<h2>People</h2><p>We name organisations, office-holders and public leaders. We do not name private individuals who were detained or injured unless they have spoken publicly.</p>' +
      '<h2>The map</h2><p>' + esc(MAP.source) + ' Pins mark the city or site where a movement is reported, not every place it reaches.</p>' +
      '<h2>Reuse</h2><p>The data is free to reuse under CC BY 4.0: <a href="data/movements.json" target="_blank" rel="noopener">movements with their reports (JSON)</a>, <a href="data/reports.csv" target="_blank" rel="noopener">every report (CSV)</a>, or the <a href="feed.xml" target="_blank" rel="noopener">feed of new reports</a>.</p>' +
      '</div></article></main>';
  }

  function footer() {
    return '<footer class="foot gut"><div class="wrap"><p>Andolan Index is independent and is not affiliated with any party, union, organisation or government. Summaries are written in our own words, and where protesters and authorities disagree, each account is attributed to whoever gave it.</p>' +
      '<p>Data under CC BY 4.0: <a href="data/movements.json" target="_blank" rel="noopener">JSON</a>, <a href="data/reports.csv" target="_blank" rel="noopener">CSV</a>, <a href="feed.xml" target="_blank" rel="noopener">feed</a>' +
      (D.config.repo_url ? ', <a href="' + esc(D.config.repo_url) + '" target="_blank" rel="noopener">source and corrections</a>' : "") +
      '. Map: DataMeet India, CC BY 4.0, showing the official boundary of India.</p></div></footer>';
  }

  /* ---------- render ---------- */
  function render() {
    storyDestroy();
    var m = ui.view === "movement" ? byId[ui.id] : null;
    if (ui.view === "movement" && !m) ui.view = "home";
    app.innerHTML = nav() + (ui.view === "home" ? home() : ui.view === "about" ? about() : movement(m)) + footer();
    document.title = ui.view === "movement" ? m.name + " | Andolan Index" : ui.view === "about" ? "How this works | Andolan Index" : D.config.title;
    layoutAll();
    placeIndicator();
    if (ui.view === "home") storyInit();
    ui.first = false;
  }
  function updateList(animate) {
    var rows = document.getElementById("rows");
    if (!rows) return;
    var apply = function () {
      rows.innerHTML = rowsHtml();
      layoutAll();
      document.getElementById("fnote").innerHTML = noteHtml();
      app.querySelectorAll(".seg button[data-status]").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.status === ui.status)); });
      app.querySelectorAll(".cause").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.cause === ui.cause)); });
      var sel = document.getElementById("statesel");
      if (sel) sel.value = ui.state;
      if (story) story.svg.querySelectorAll(".st").forEach(function (p) { p.classList.toggle("sel", !!ui.state && p.dataset.state === ui.state); });
      placeIndicator();
    };
    if (animate) transition(apply); else apply();
  }
  function placeIndicator() {
    app.querySelectorAll(".seg").forEach(function (seg) {
      var on = seg.querySelector('[aria-checked="true"]'), ind = seg.querySelector(".seg-ind");
      if (!on || !ind) return;
      ind.style.width = on.offsetWidth + "px";
      ind.style.height = on.offsetHeight + "px";
      ind.style.transform = "translate(" + on.offsetLeft + "px," + (on.offsetTop - 3) + "px)";
    });
  }
  function scrollToLedger() {
    var led = document.getElementById("ledger");
    if (led) led.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
  }

  /* ---------- navigation ---------- */
  function go(view, id, push, anchor) {
    if (ui.view === "home") ui.homeScroll = window.scrollY;
    var target = view === "home" ? ui.homeScroll : 0;
    hideTip();
    transition(function () {
      ui.view = view; ui.id = id || null;
      render();
      var el = anchor && document.getElementById(anchor);
      window.scrollTo(0, el ? el.getBoundingClientRect().top + window.scrollY - (el.classList.contains("rep") ? 140 : 72) : target);
      if (el && el.classList.contains("rep")) { el.classList.add("flash"); setTimeout(function () { el.classList.remove("flash"); }, 2600); }
    });
    if (push !== false) {
      var h = view === "movement" ? "#" + id : view === "about" ? "#about" : location.pathname + location.search;
      try { history.pushState({ d: navDepth() + 1 }, "", h); } catch (e) { /* the viewer may not allow it */ }
    }
  }
  function fromHash() {
    var h = decodeURIComponent((location.hash || "").slice(1));
    if (byId[h]) return ["movement", h];
    if (h === "about") return ["about", null];
    return ["home", h === "ledger" ? "ledger" : null];
  }
  function navDepth() { try { return (history.state && history.state.d) || 0; } catch (e) { return 0; } }
  window.addEventListener("popstate", function () { var r = fromHash(); go(r[0], r[0] === "movement" ? r[1] : null, false); });

  /* ---------- events ---------- */
  /* ---------- phones: what is at this spot on the map ---------- */
  function newestRead(m) {
    var recs = m.reports.filter(onRecord);
    return recs.filter(function (r) { return r.read; })[0] || recs[0] || m.reports[0];
  }
  function sheetRow(m, r, place) {
    return '<a class="sh-row" href="#' + m.id + '" data-go="' + m.id + '" data-anchor="r-' + esc(r.id) + '">' +
      '<span class="sh-mv">' + glyph(m.status) + esc(m._short) + (place ? '<small>' + esc(place) + '</small>' : "") + '</span>' +
      '<span class="sh-src">' + esc(r.outlet) + ', ' + fmt(r.date, { short: true, noYear: sameYear(r.date) }) + '</span>' +
      '<span class="sh-sum">' + esc(r.summary) + '</span></a>';
  }
  // the visible dots within a fingertip of a point on screen, nearest first
  function dotsNear(x, y, radius) {
    var s = story, found = [];
    s.pins.forEach(function (el, j) {
      var r = el.getBoundingClientRect(), st = getComputedStyle(el);
      if (st.visibility === "hidden" || pinHidden(j)) return; // dimmed dots still count; hidden ones do not
      var d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
      if (d <= radius) found.push({ j: j, d: d });
    });
    return found.sort(function (a, b) { return a.d - b.d; });
  }
  function openSheet(title, movements, places) {
    var s = story;
    if (!s) return;
    closeSheet();
    var one = movements.length === 1, ids = {};
    movements.forEach(function (m) { ids[m.id] = 1; });
    var html = '<div class="sheet' + (one ? "" : " many") + '" role="dialog" aria-modal="false" aria-label="' + esc(title) + '">' +
      '<div class="sh-head"><p class="sh-title">' + esc(title) + '</p>' +
      '<button type="button" class="sh-x" data-close-sheet aria-label="Close"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>' +
      '<div class="sh-body">' + (movements.length ? movements.map(function (m) { return sheetRow(m, newestRead(m), places && places[m.id]); }).join("")
        : '<p class="sh-none">No protests on record here yet.</p>') + '</div>' +
      (one ? '<p class="sh-foot">' + STATUS[movements[0].status] + ', ' + plural(movements[0].report_count, "report") +
        ' <a href="#' + movements[0].id + '" data-go="' + movements[0].id + '">Open the file</a></p>' : "") + '</div>';
    app.insertAdjacentHTML("beforeend", html);
    s.sheet = app.lastElementChild;
    s.el.classList.add("listing");
    s.pins.forEach(function (el, j) { el.classList.toggle("lit", !!ids[PINS[j].m.id]); });
    requestAnimationFrame(function () { if (s.sheet) { s.sheet.classList.add("in"); var f = s.sheet.querySelector(".sh-row"); if (f) f.focus({ preventScroll: true }); } });
  }
  // a tap on the map: the dots under the finger, or else the protests in the state that was tapped
  function tapMap(x, y, stateName) {
    // In a crowded spot (Delhi and its neighbours) a fingertip covers several dots, so list the whole cluster, nearest first.
    var near = dotsNear(x, y, 30).length >= 3 ? dotsNear(x, y, 48) : dotsNear(x, y, 20), places = {}, ms = [];
    near.forEach(function (d) { var m = PINS[d.j].m; if (!places[m.id]) { places[m.id] = PINS[d.j].name; ms.push(m); } });
    if (ms.length) {
      var place = PINS[near[0].j].name;
      openSheet(ms.length === 1 ? place : ms.length + " protests near " + place, ms, places);
      return true;
    }
    if (!stateName) return false;
    var list = ((STATS[stateName] || {}).moves || []).filter(function (m) { return m.reports.length; });
    var where = {};
    list.forEach(function (m) { where[m.id] = placesOf(m); });
    openSheet(stateName + (list.length ? ": " + plural(list.length, "movement") : ""), list, where);
    return true;
  }
  function closeSheet() {
    var s = story;
    if (!s || !s.sheet) return;
    var el = s.sheet;
    s.sheet = null;
    el.classList.remove("in");
    setTimeout(function () { el.remove(); }, 300);
    s.el.classList.remove("listing");
    s.pins.forEach(function (p) { p.classList.remove("lit"); });
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSheet(); });

  app.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest("[data-close-sheet]")) { closeSheet(); return; }
    // Phones: the map is too small to aim at a dot, so any tap on it opens a panel of what is there.
    if (story && NARROW.matches && t.closest(".story .stage") && !(e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      var tp = t.closest(".story .pin"), tr = tp && tp.getBoundingClientRect();
      var x = tr ? tr.left + tr.width / 2 : e.clientX, y = tr ? tr.top + tr.height / 2 : e.clientY;
      var stEl = t.closest(".st");
      if (!tapMap(x, y, stEl ? stEl.dataset.state : null)) closeSheet();
      return;
    }
    if (story && story.sheet && !t.closest(".sheet")) { closeSheet(); if (!t.closest("[data-go]")) return; }
    var nav_ = t.closest("[data-go]");
    if (nav_ && !(e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      var v = nav_.dataset.go;
      if (v === "ledger") {
        if (ui.view === "home") scrollToLedger();
        else { go("home", null); setTimeout(scrollToLedger, 60); }
      } else if (v === "") go("home");
      else if (v === "about") go("about", null, true, nav_.dataset.anchor);
      else go("movement", v, true, nav_.dataset.anchor);
      return;
    }
    if (t.closest("[data-back]")) {
      e.preventDefault();
      if (navDepth() > 0) history.back(); else go("home");
      return;
    }
    var jump = t.closest("[data-jump]");
    if (jump) {
      e.preventDefault();
      var dest = document.getElementById(jump.dataset.jump);
      if (dest) dest.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
      return;
    }
    var gal = t.closest("[data-gal]");
    if (gal) {
      var g = document.getElementById("gallery"), card = g && g.querySelector(".issue");
      if (g && card) g.scrollBy({ left: (+gal.dataset.gal) * (card.offsetWidth + 20), behavior: REDUCE ? "auto" : "smooth" });
      return;
    }
    var rowEl = t.closest(".row[data-id]");
    if (rowEl && !t.closest("a,button")) { go("movement", rowEl.dataset.id); return; }
    var stPath = t.closest(".story .st");
    if (stPath && STATS[stPath.dataset.state]) { ui.state = stPath.dataset.state; updateList(false); scrollToLedger(); return; }
    var rg = t.closest("[data-range]");
    if (rg) {
      ui.range = rg.dataset.range;
      try { localStorage.setItem("andolan-range", ui.range); } catch (err) { /* not essential */ }
      app.querySelectorAll("[data-range]").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.range === ui.range)); });
      placeIndicator();
      layoutAll();
      return;
    }
    var st = t.closest("[data-status]");
    if (st) { ui.status = st.dataset.status; updateList(true); return; }
    var c = t.closest("[data-cause]");
    if (c) { ui.cause = ui.cause === c.dataset.cause ? "" : c.dataset.cause; updateList(true); return; }
    if (t.closest("[data-clear]")) {
      ui.status = ui.cause = ui.state = ui.q = "";
      var q = document.getElementById("q"); if (q) q.value = "";
      updateList(true);
      return;
    }
    var cp = t.closest("[data-copy]");
    if (cp) {
      var src = document.getElementById(cp.dataset.copy), text = src.textContent;
      var done = function () { cp.textContent = "Copied"; setTimeout(function () { cp.textContent = "Copy citation"; }, 1800); };
      var fallback = function () { var r = document.createRange(); r.selectNodeContents(src); var s = getSelection(); s.removeAllRanges(); s.addRange(r); cp.textContent = "Selected. Press Ctrl+C or ⌘C to copy"; };
      try { navigator.clipboard.writeText(text).then(done, fallback); } catch (err) { fallback(); }
    }
  });
  app.addEventListener("input", function (e) {
    if (e.target.id !== "q") return;
    ui.q = e.target.value.trim().toLowerCase();
    updateList(false);
  });
  app.addEventListener("change", function (e) {
    if (e.target.id !== "statesel") return;
    ui.state = e.target.value;
    updateList(true);
  });

  // Pointing at a movement in the story lights up its pins; pointing at a pin shows its news card; a card under the
  // pointer stays put.
  function litMovement(id) {
    var s = story;
    if (!s) return;
    s.el.classList.toggle("listing", !!id);
    s.pins.forEach(function (p, i) { p.classList.toggle("lit", !!id && PINS[i].m.id === id); });
    focusTag(id);
  }
  app.addEventListener("mouseover", function (e) {
    var t = e.target, lit = t.closest("[data-lit]");
    if (story) {
      if (!story.sheet) litMovement(lit ? lit.dataset.lit : null);
      var pin = t.closest(".story .pin"), onCard = t.closest(".story .card");
      if (pin) holdPin(+pin.dataset.pin);
      else if (onCard) clearTimeout(story.release);
      else if (lit && (story.step === 2 || story.step === 4)) holdMovement(byId[lit.dataset.lit]);
      else releasePin();
      story.paused = !!onCard;
    }
    var tipEl = t.closest("[data-tip]");
    if (tipEl) showTip(tipEl, e); else hideTip();
  });
  app.addEventListener("focusin", function (e) {
    var lit = e.target.closest("[data-lit]");
    if (story && lit) { litMovement(lit.dataset.lit); if (story.step === 2 || story.step === 4) holdMovement(byId[lit.dataset.lit]); }
    var pin = e.target.closest(".story .pin");
    if (pin) holdPin(+pin.dataset.pin);
    var el = e.target.closest("[data-tip]");
    if (el) showTip(el);
  });
  app.addEventListener("focusout", function (e) {
    hideTip();
    if (story && !story.sheet) { litMovement(null); if (e.target.closest(".story .pin, .story [data-lit]")) releasePin(true); }
  });
  app.addEventListener("mouseleave", function () { hideTip(); if (story) { story.paused = false; litMovement(null); releasePin(); } });

  // Tooltips go above what they describe, or below, right or left, whichever first stays on screen and clear of news cards.
  function showTip(el, ev) {
    if (!tip) return;
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight, a;
    if (ev && el.tagName.toLowerCase() === "path") a = { left: ev.clientX - 6, right: ev.clientX + 6, top: ev.clientY - 6, bottom: ev.clientY + 6 };
    else a = el.getBoundingClientRect();
    var cx = (a.left + a.right) / 2, cy = (a.top + a.bottom) / 2, vw = window.innerWidth, vh = window.innerHeight;
    var cards = Array.prototype.map.call(document.querySelectorAll(".card.in"), function (c) { var r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    var spots = [[cx - w / 2, a.top - h - 10], [cx - w / 2, a.bottom + 10], [a.right + 12, cy - h / 2], [a.left - w - 12, cy - h / 2]].map(function (c) {
      return { x: Math.min(Math.max(8, c[0]), vw - w - 8), y: c[1], w: w, h: h };
    });
    var pick = spots.filter(function (r) { return r.y >= 8 && r.y + h <= vh - 8 && !cards.some(function (c) { return overlaps(r, c, 6); }); })[0] ||
      spots.filter(function (r) { return r.y >= 8 && r.y + h <= vh - 8; })[0] || spots[0];
    tip.style.left = pick.x + "px";
    tip.style.top = Math.max(8, pick.y) + "px";
  }
  function hideTip() { if (tip) tip.hidden = true; }
  window.addEventListener("scroll", hideTip, { passive: true });
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    placeIndicator();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { layoutAll(); if (story) { readScroll(); layoutPins(); } }, 120);
  });
  document.addEventListener("visibilitychange", function () { if (document.hidden) clearCards(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placeIndicator(); if (story) layoutPins(); });

  /* ---------- start ---------- */
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) { /* not essential */ }
  var first = fromHash();
  ui.view = first[0]; ui.id = first[0] === "movement" ? first[1] : null;
  render();
  if (first[1] === "ledger") setTimeout(scrollToLedger, 50);
})();
