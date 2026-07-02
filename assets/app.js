/* Signal Tracker dashboard.
 * SECURITY (I3): every piece of source-derived text is rendered with
 * textContent / createTextNode — never innerHTML. Posts are untrusted input.
 * SVG sparklines are built with createElementNS + attributes only.
 */
"use strict";

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3 };
const DIR_GLYPH = { bullish: "▲", bearish: "▼" };
const HORIZONS = ["1", "3", "7", "30"];
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  signals: [],
  prices: null,       // populated by the M2 evidence layer
  summary: null,
  filters: { priority: "", direction: "", source: "", from: "", to: "", search: "", sort: "priority" },
};

/* ── helpers ─────────────────────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // text nodes only
  return node;
}

async function fetchJSON(path) {
  const resp = await fetch(path, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

function relativeAge(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

function fmtPct(x, signed = true) {
  const pct = (x * 100).toFixed(1);
  return `${signed && x > 0 ? "+" : ""}${pct}%`;
}

function horizonsFor(sig) {
  const p = state.prices;
  if (!p || !p.signals || !p.signals[sig.mention_id]) return null;
  return p.signals[sig.mention_id].horizons || null;
}

/* ── KPI strip ───────────────────────────────────────────── */

function renderKPIs() {
  const s = state.signals;
  document.getElementById("k-total").textContent = String(s.length);
  const crit = s.filter((r) => r.signal.priority === "P1" || r.signal.priority === "P2").length;
  document.getElementById("k-critical").textContent = String(crit);

  const bulls = s.filter((r) => r.signal.direction === "bullish").length;
  const bears = s.filter((r) => r.signal.direction === "bearish").length;
  const split = document.getElementById("k-split");
  split.replaceChildren();
  const up = el("span", "up", `▲${bulls}`);
  const sep = document.createTextNode(" / ");
  const down = el("span", "down", `▼${bears}`);
  split.append(up, sep, down);

  const latest = s.length
    ? s.map((r) => r.timestamp_utc).sort().at(-1)
    : null;
  document.getElementById("k-latest").textContent = latest ? relativeAge(latest) : "—";
}

/* ── evidence panel (renders when M2 prices.json exists) ─── */

function renderEvidence() {
  const p = state.prices;
  if (!p || !Array.isArray(p.aggregates) || !p.aggregates.length) return;
  const body = document.getElementById("evidence-body");
  body.replaceChildren();

  const table = el("table", "ev");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.appendChild(el("th", null, "tier"));
  hr.appendChild(el("th", null, "n"));
  for (const h of HORIZONS) {
    hr.appendChild(el("th", null, `+${h}d xs`));
    hr.appendChild(el("th", null, "hit"));
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of p.aggregates) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", null,
      `${row.priority} ${DIR_GLYPH[row.direction] || ""}`));
    tr.appendChild(el("td", "n", String(row.n)));
    for (const h of HORIZONS) {
      const cell = (row.horizons || {})[h];
      if (!cell || cell.mean_excess_return == null) {
        tr.appendChild(el("td", "n", "·"));
        tr.appendChild(el("td", "n", "·"));
        continue;
      }
      const mean = cell.mean_excess_return;
      // Win-colored: a bearish tier "wins" when excess return is negative (§7).
      const win = row.direction === "bearish" ? mean <= 0 : mean >= 0;
      tr.appendChild(el("td", win ? "pos" : "neg", fmtPct(mean)));
      tr.appendChild(el("td", "n",
        cell.hit_rate == null ? "·" : `${Math.round(cell.hit_rate * 100)}%`));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

/* ── sparkline: excess-return trajectory across horizons ─── */

function sparkline(horizons, bearish) {
  const pts = HORIZONS
    .map((h) => (horizons[h] && horizons[h].excess_return != null) ? horizons[h].excess_return : null);
  const known = pts.filter((v) => v !== null);
  if (known.length < 2) return null;

  const w = 84, ht = 26, pad = 3;
  const lo = Math.min(0, ...known), hi = Math.max(0, ...known);
  const span = (hi - lo) || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (HORIZONS.length - 1);
  const y = (v) => ht - pad - ((v - lo) / span) * (ht - 2 * pad);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("width", w);
  svg.setAttribute("height", ht);
  svg.setAttribute("viewBox", `0 0 ${w} ${ht}`);

  const axis = document.createElementNS(SVG_NS, "line");
  axis.setAttribute("class", "axis");
  axis.setAttribute("x1", pad); axis.setAttribute("x2", w - pad);
  axis.setAttribute("y1", y(0)); axis.setAttribute("y2", y(0));
  svg.appendChild(axis);

  const line = document.createElementNS(SVG_NS, "polyline");
  const coords = [];
  pts.forEach((v, i) => { if (v !== null) coords.push(`${x(i)},${y(v)}`); });
  line.setAttribute("points", coords.join(" "));
  const last = known.at(-1);
  const good = bearish ? last <= 0 : last >= 0;
  line.setAttribute("stroke", good ? "#34d399" : "#fb7185");
  svg.appendChild(line);
  return svg;
}

/* ── feed ────────────────────────────────────────────────── */

function card(rec) {
  const s = rec.signal;
  const c = el("article", "card");

  const head = el("div", "head");
  head.appendChild(el("span", `badge ${s.priority}`, s.priority));
  head.appendChild(el("span", `dir ${s.direction}`,
    `${DIR_GLYPH[s.direction] || ""} ${s.direction || ""}`));
  const subject = (s.tickers && s.tickers.length ? s.tickers.join(" · ")
    : (s.entities || []).join(" · ")) || "—";
  head.appendChild(el("span", "tickers", subject));
  c.appendChild(head);

  c.appendChild(el("blockquote", "quote", `“${s.exact_quote}”`));

  const meta = el("div", "meta");
  const link = el("a", null, rec.source);
  link.href = rec.url;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  meta.appendChild(link);
  const ts = new Date(rec.timestamp_utc);
  meta.appendChild(el("span", null, ts.toISOString().slice(0, 16).replace("T", " ") + " UTC"));
  meta.appendChild(el("span", null, relativeAge(rec.timestamp_utc)));

  const confWrap = el("span", "conf-track");
  const confFill = el("span", "conf-fill");
  confFill.style.width = `${Math.round(Number(s.confidence) * 100)}%`;
  confWrap.appendChild(confFill);
  confWrap.title = `confidence ${Number(s.confidence).toFixed(2)}`;
  meta.appendChild(confWrap);
  meta.appendChild(el("span", null, Number(s.confidence).toFixed(2)));
  c.appendChild(meta);

  const horizons = horizonsFor(s);
  if (horizons) {
    const row = el("div", "returns");
    row.appendChild(el("span", "h", "xs vs SPY"));
    const spark = sparkline(horizons, s.direction === "bearish");
    if (spark) row.appendChild(spark);
    for (const h of HORIZONS) {
      const cell = horizons[h];
      if (!cell || cell.excess_return == null) continue;
      const v = cell.excess_return;
      // Win-colored to match the spec's inverted evaluation for bearish (§7).
      const win = s.direction === "bearish" ? v <= 0 : v >= 0;
      row.appendChild(el("span", win ? "pos" : "neg", `+${h}d ${fmtPct(v)}`));
    }
    if (row.childNodes.length > 1) c.appendChild(row);
  }
  return c;
}

function applyFilters() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  let items = state.signals.filter((rec) => {
    const s = rec.signal;
    if (f.priority && s.priority !== f.priority) return false;
    if (f.direction && s.direction !== f.direction) return false;
    if (f.source && rec.source !== f.source) return false;
    const day = rec.timestamp_utc.slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (q) {
      const hay = [s.exact_quote, ...(s.tickers || []), ...(s.entities || [])]
        .join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  items.sort((a, b) => {
    if (f.sort === "recency") return b.timestamp_utc.localeCompare(a.timestamp_utc);
    return (PRIORITY_ORDER[a.signal.priority] ?? 9) - (PRIORITY_ORDER[b.signal.priority] ?? 9)
      || b.timestamp_utc.localeCompare(a.timestamp_utc);
  });
  return items;
}

function renderFeed() {
  const feed = document.getElementById("feed");
  feed.replaceChildren();
  const items = applyFilters();
  if (!items.length) {
    const box = el("div", "empty");
    box.appendChild(el("p", null, state.signals.length
      ? "No signals match the current filters."
      : "No signals stored yet — the poller hasn't caught one, which is itself data."));
    feed.appendChild(box);
    return;
  }
  items.forEach((rec, i) => {
    const c = card(rec);
    c.style.animationDelay = `${Math.min(i * 35, 350)}ms`;
    feed.appendChild(c);
  });
}

/* ── sync status ─────────────────────────────────────────── */

function renderSync(ok) {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (!ok) {
    dot.className = "dot err";
    label.textContent = "no data";
    return;
  }
  dot.className = "dot live";
  const ran = state.summary && state.summary.run_at_utc;
  label.textContent = ran ? `updated ${relativeAge(ran)}` : "live";
  const foot = document.getElementById("foot-meta");
  if (state.summary) {
    foot.textContent =
      `last run ${ran ? new Date(ran).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—"}` +
      ` · prefilter pass ${state.summary.prefilter_pass_rate_pct ?? "—"}%`;
  }
}

/* ── init ────────────────────────────────────────────────── */

function wireFilters() {
  for (const groupId of ["f-priority", "f-direction"]) {
    const group = document.getElementById(groupId);
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button.pill");
      if (!btn) return;
      for (const b of group.querySelectorAll(".pill")) b.classList.remove("active");
      btn.classList.add("active");
      state.filters[groupId === "f-priority" ? "priority" : "direction"] = btn.dataset.value;
      renderFeed();
    });
  }
  const bind = (id, key, evt = "change") =>
    document.getElementById(id).addEventListener(evt, (e) => {
      state.filters[key] = e.target.value;
      renderFeed();
    });
  bind("f-source", "source");
  bind("f-from", "from");
  bind("f-to", "to");
  bind("f-sort", "sort");
  bind("f-search", "search", "input");
}

async function init() {
  wireFilters();
  const status = document.getElementById("status");
  try {
    state.signals = await fetchJSON("data/signals.json");
  } catch (e) {
    status.replaceChildren();
    status.appendChild(el("p", null,
      "Could not load data/signals.json. If you opened this file directly, serve it over HTTP (GitHub Pages or `python3 -m http.server`)."));
    renderSync(false);
    return;
  }
  try { state.prices = await fetchJSON("data/prices.json"); } catch { state.prices = null; }
  try { state.summary = await fetchJSON("data/run_summary.json"); } catch { state.summary = null; }

  status.remove();
  renderSync(true);
  renderKPIs();
  renderEvidence();
  renderFeed();
}

init();
