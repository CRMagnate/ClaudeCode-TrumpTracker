/* Trump Market-Signal Tracker dashboard.
 * SECURITY (I3): every piece of source-derived text is rendered with
 * textContent / createTextNode — never innerHTML. Posts are untrusted input.
 */
"use strict";

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3 };
const DIR_GLYPH = { bullish: "▲", bearish: "▼" };

let SIGNALS = [];
let PRICES = null; // populated in M2

async function fetchJSON(path) {
  const resp = await fetch(path, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // text nodes only
  return node;
}

function relativeAge(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

function card(rec) {
  const s = rec.signal;
  const c = el("article", "card");

  const head = el("div", "head");
  head.appendChild(el("span", `badge ${s.priority}`, s.priority));
  head.appendChild(el("span", `dir ${s.direction}`,
    `${DIR_GLYPH[s.direction] || ""} ${s.direction || ""}`));
  const subject = (s.tickers && s.tickers.length ? s.tickers.join(", ")
    : (s.entities || []).join(", ")) || "—";
  head.appendChild(el("span", "tickers", subject));
  c.appendChild(head);

  c.appendChild(el("blockquote", "quote", `“${s.exact_quote}”`));

  const meta = el("div", "meta");
  const link = el("a", null, rec.source);
  link.href = rec.url;             // href from our own stored data
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  meta.appendChild(link);
  meta.appendChild(el("span", null, new Date(rec.timestamp_utc).toISOString().replace(".000Z", "Z")));
  meta.appendChild(el("span", null, relativeAge(rec.timestamp_utc)));
  meta.appendChild(el("span", null, `conf ${Number(s.confidence).toFixed(2)}`));
  c.appendChild(meta);

  const perf = performanceRow(s);
  if (perf) c.appendChild(perf);
  return c;
}

function performanceRow(s) {
  // M2: per-signal excess-return trajectory from prices.json
  if (!PRICES || !PRICES.signals || !PRICES.signals[s.mention_id]) return null;
  const rows = PRICES.signals[s.mention_id].horizons || {};
  const wrap = el("div", "returns");
  wrap.appendChild(el("span", null, "excess vs SPY: "));
  for (const [h, v] of Object.entries(rows)) {
    if (v == null || v.excess_return == null) continue;
    const pct = (v.excess_return * 100).toFixed(1);
    const span = el("span", v.excess_return >= 0 ? "pos" : "neg", ` +${h}d ${pct > 0 ? "+" : ""}${pct}% `);
    wrap.appendChild(span);
  }
  return wrap.childNodes.length > 1 ? wrap : null;
}

function filters() {
  return {
    priority: document.getElementById("f-priority").value,
    direction: document.getElementById("f-direction").value,
    source: document.getElementById("f-source").value,
    from: document.getElementById("f-from").value,
    to: document.getElementById("f-to").value,
  };
}

function render() {
  const feed = document.getElementById("feed");
  feed.replaceChildren();
  const f = filters();
  let items = SIGNALS.filter((rec) => {
    const s = rec.signal;
    if (f.priority && s.priority !== f.priority) return false;
    if (f.direction && s.direction !== f.direction) return false;
    if (f.source && rec.source !== f.source) return false;
    const day = rec.timestamp_utc.slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    return true;
  });
  items.sort((a, b) =>
    (PRIORITY_ORDER[a.signal.priority] ?? 9) - (PRIORITY_ORDER[b.signal.priority] ?? 9)
    || b.timestamp_utc.localeCompare(a.timestamp_utc));
  if (!items.length) {
    feed.appendChild(el("p", null, "No signals match the current filters."));
    return;
  }
  for (const rec of items) feed.appendChild(card(rec));
}

function renderEvidence() {
  // M2: aggregates (tier × direction, excess return, hit rate, n) from prices.json
  if (!PRICES || !PRICES.aggregates) return;
  const panel = document.getElementById("evidence");
  const body = document.getElementById("evidence-body");
  body.replaceChildren();
  panel.hidden = false;
  // table built with text nodes in M2
}

async function init() {
  const status = document.getElementById("status");
  try {
    SIGNALS = await fetchJSON("data/signals.json");
  } catch (e) {
    status.textContent = "Could not load data/signals.json — no data yet or Pages not serving the repo root.";
    return;
  }
  try {
    PRICES = await fetchJSON("data/prices.json");
  } catch (e) {
    PRICES = null; // fine until M2
  }
  status.remove();
  render();
  renderEvidence();
  for (const id of ["f-priority", "f-direction", "f-source", "f-from", "f-to"]) {
    document.getElementById(id).addEventListener("change", render);
  }
}

init();
