/* Signal Constellation — dependency-free 3D network on <canvas>.
 *
 * Structure: each traded asset (ticker, or entity when no ticker) is a HUB;
 * each signal is a NODE orbiting its hub. Link + node colors encode state:
 *   green  — strong bullish signal, or a link whose trade is CONFIRMED
 *            (excess return moving the signalled way once evidence exists)
 *   yellow — moderate / unproven
 *   red    — bearish signals and losing trades
 * The more green links converging on a hub, the more confirmations that
 * trade has. Hubs glow brighter as green links accumulate.
 *
 * SECURITY (I3): tooltip content is set via textContent only. Canvas text is
 * drawn with fillText (inert). No source-derived string touches innerHTML.
 */
"use strict";

const Constellation = (() => {
  const COLORS = {
    green: [52, 211, 153],
    yellow: [255, 214, 107],
    red: [251, 113, 133],
    hub: [94, 234, 212],
    faint: [92, 101, 117],
  };
  const FOCAL = 420;           // perspective focal length
  const AUTO_SPIN = 0.0022;    // radians / frame
  const TAU = Math.PI * 2;

  let canvas, ctx, tooltip, dpr = 1, W = 0, H = 0;
  let hubs = [], nodes = [], links = [], stars = [];
  let rotY = 0.6, rotX = -0.18, targetRotX = -0.18;
  let dragging = false, lastX = 0, lastY = 0, spin = AUTO_SPIN;
  let hovered = null, raf = null, t = 0;
  let reduced = false, empty = false;

  /* ── graph construction ─────────────────────────────────── */

  function latestExcess(prices, mentionId) {
    const rec = prices && prices.signals && prices.signals[mentionId];
    if (!rec || !rec.horizons) return null;
    for (const h of ["30", "7", "3", "1"]) {
      const c = rec.horizons[h];
      if (c && c.excess_return != null) return c.excess_return;
    }
    return null;
  }

  function nodeColor(sig, xs) {
    if (xs != null) {
      const win = sig.direction === "bearish" ? xs <= 0 : xs >= 0;
      if (sig.direction === "bearish") return win ? "red" : "yellow"; // red = bearish by design
      return win ? "green" : "yellow";
    }
    if (sig.direction === "bearish") return "red";
    const strong = (sig.priority === "P1" || sig.priority === "P2") && sig.confidence >= 0.75;
    return strong ? "green" : "yellow";
  }

  function linkColor(sig, xs) {
    if (xs != null) {
      const win = sig.direction === "bearish" ? xs <= 0 : xs >= 0;
      return win ? "green" : "red";   // confirmed vs contradicted by the market
    }
    return nodeColor(sig, null) === "green" ? "green" : "yellow";
  }

  function fibonacciSphere(i, n, r) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    return { x: Math.cos(th) * rad * r, y: y * r * 0.72, z: Math.sin(th) * rad * r };
  }

  function build(signals, prices) {
    hubs = []; nodes = []; links = []; stars = [];
    empty = !signals || !signals.length;

    for (let i = 0; i < 70; i++) {         // ambient depth starfield
      const p = fibonacciSphere(i, 70, 210 + (i % 5) * 26);
      stars.push({ ...p, phase: Math.random() * TAU });
    }

    if (empty) {                       // ambient placeholder network
      for (let i = 0; i < 14; i++) {
        const p = fibonacciSphere(i, 14, 105);
        hubs.push({ ...p, label: "", size: 2.2, color: "faint", green: 0, phase: Math.random() * TAU });
      }
      for (let i = 0; i < 13; i++) {
        links.push({ a: hubs[i], b: hubs[(i * 5 + 3) % 14], color: "faint", w: 0.5 });
      }
      return;
    }

    const byKey = new Map();
    for (const rec of signals) {
      const s = rec.signal;
      const key = (s.tickers && s.tickers[0]) || (s.entities && s.entities[0]) || "—";
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(rec);
    }

    const keys = [...byKey.keys()];
    keys.forEach((key, i) => {
      const members = byKey.get(key);
      const p = fibonacciSphere(i, keys.length, 132);
      const hub = {
        ...p, label: key, members,
        size: 3.4 + Math.min(members.length * 1.1, 6),
        color: "hub", green: 0, phase: Math.random() * TAU,
      };
      hubs.push(hub);
      members.forEach((rec, j) => {
        const s = rec.signal;
        const xs = latestExcess(prices, s.mention_id);
        const a1 = (j / members.length) * TAU + i, a2 = ((j * 2.4) % TAU);
        const r = 30 + (j % 3) * 8;
        const node = {
          x: hub.x + Math.cos(a1) * Math.cos(a2) * r,
          y: hub.y + Math.sin(a2) * r * 0.8,
          z: hub.z + Math.sin(a1) * Math.cos(a2) * r,
          rec, size: s.priority === "P1" ? 4.6 : s.priority === "P2" ? 3.8 : 3.0,
          color: nodeColor(s, xs), pulse: s.priority === "P1",
          phase: Math.random() * TAU,
        };
        nodes.push(node);
        const lc = linkColor(s, xs);
        if (lc === "green") hub.green++;
        links.push({ a: node, b: hub, color: lc, w: lc === "green" ? 1.4 : 0.9 });
      });
    });
  }

  /* ── projection & drawing ───────────────────────────────── */

  function project(p, cy, sy, cx, sx) {
    const x1 = p.x * cy - p.z * sy;
    const z1 = p.x * sy + p.z * cy;
    const y2 = p.y * cx - z1 * sx;
    const z2 = p.y * sx + z1 * cx;
    const s = FOCAL / (FOCAL + z2);
    return { x: W / 2 + x1 * s, y: H / 2 + y2 * s, s, z: z2 };
  }

  function rgba(name, a) {
    const [r, g, b] = COLORS[name];
    return `rgba(${r},${g},${b},${a})`;
  }

  function bob(p, phase) {
    if (reduced) return p;
    return { x: p.x, y: p.y + Math.sin(t * 0.02 + phase) * 2.4, z: p.z };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const cx = Math.cos(rotX), sx = Math.sin(rotX);

    // starfield: slower parallax rotation, twinkle
    const scy = Math.cos(rotY * 0.4), ssy = Math.sin(rotY * 0.4);
    for (const st of stars) {
      const p = project(st, scy, ssy, cx, sx);
      const tw = reduced ? 0.5 : 0.35 + 0.3 * Math.sin(t * 0.03 + st.phase);
      ctx.fillStyle = rgba("faint", tw * Math.max(0.15, p.s - 0.35));
      ctx.fillRect(p.x, p.y, 1.3, 1.3);
    }

    const projected = [];
    for (const n of [...hubs, ...nodes]) {
      n._p = project(bob(n, n.phase), cy, sy, cx, sx);
      projected.push(n);
    }

    // links first, back-to-front alpha by depth
    for (const l of links) {
      const a = l.a._p, b = l.b._p;
      const depth = ((a.s + b.s) / 2 - 0.55) / 0.9;
      const alpha = Math.max(0.12, Math.min(0.6, depth * 0.6));
      const glowing = l.color === "green" && !reduced
        ? 0.15 * (1 + Math.sin(t * 0.05 + a.x * 0.01)) : 0;
      ctx.strokeStyle = rgba(l.color, alpha + glowing);
      ctx.lineWidth = l.w * ((a.s + b.s) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // nodes back-to-front
    projected.sort((m, n) => m._p.z > n._p.z ? -1 : 1);
    for (const n of projected) {
      const p = n._p;
      let r = n.size * p.s;
      if (n.pulse && !reduced) r *= 1 + 0.16 * Math.sin(t * 0.09 + n.phase);
      const alpha = Math.max(0.25, Math.min(1, p.s - 0.1));
      const glow = n.color === "hub" ? 6 + n.green * 3 : (n.color === "green" ? 8 : 5);

      ctx.shadowColor = rgba(n.color === "hub" && n.green ? "green" : n.color, 0.8);
      ctx.shadowBlur = glow * p.s;
      ctx.fillStyle = rgba(n.color, alpha);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (n === hovered) {
        ctx.strokeStyle = rgba(n.color, 0.9);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, TAU);
        ctx.stroke();
      }
      if (n.label && (p.s > 0.86 || n === hovered)) {
        ctx.fillStyle = rgba("hub", Math.min(0.9, p.s - 0.2));
        ctx.font = `600 ${Math.round(10 * p.s)}px "JetBrains Mono", monospace`;
        ctx.textAlign = "center";
        ctx.fillText(n.label, p.x, p.y - r - 6);
      }
    }
  }

  function frame() {
    t++;
    if (!dragging && !reduced) rotY += spin;
    rotX += (targetRotX - rotX) * 0.06;
    draw();
    raf = requestAnimationFrame(frame);
  }

  /* ── interaction ────────────────────────────────────────── */

  function pick(mx, my) {
    let best = null, bestD = 18;
    for (const n of [...nodes, ...hubs]) {
      if (!n._p) continue;
      const d = Math.hypot(n._p.x - mx, n._p.y - my);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  function showTooltip(n, mx, my) {
    tooltip.replaceChildren();
    if (n.rec) {
      const s = n.rec.signal;
      const head = document.createElement("div");
      head.className = "ct-head";
      head.textContent = `${s.priority} ${s.direction === "bearish" ? "▼" : "▲"} ${(s.tickers || []).join(" ") || (s.entities || []).join(", ")}`;
      const quote = document.createElement("div");
      quote.className = "ct-quote";
      const q = s.exact_quote || "";
      quote.textContent = q.length > 90 ? q.slice(0, 90) + "…" : q;
      const meta = document.createElement("div");
      meta.className = "ct-meta";
      meta.textContent = `conf ${Number(s.confidence).toFixed(2)} · ${n.rec.timestamp_utc.slice(0, 10)} · tap to open`;
      tooltip.append(head, quote, meta);
    } else if (n.label) {
      const head = document.createElement("div");
      head.className = "ct-head";
      head.textContent = n.label;
      const meta = document.createElement("div");
      meta.className = "ct-meta";
      meta.textContent = `${n.members.length} signal${n.members.length > 1 ? "s" : ""} · ${n.green} confirmation${n.green === 1 ? "" : "s"}`;
      tooltip.append(head, meta);
    } else return;
    tooltip.style.left = `${Math.min(mx + 14, W - 230)}px`;
    tooltip.style.top = `${Math.max(my - 10, 8)}px`;
    tooltip.hidden = false;
  }

  function onMove(mx, my) {
    if (dragging) {
      rotY += (mx - lastX) * 0.006;
      targetRotX = Math.max(-0.9, Math.min(0.9, targetRotX + (my - lastY) * 0.004));
      lastX = mx; lastY = my;
      tooltip.hidden = true;
      return;
    }
    hovered = pick(mx, my);
    canvas.style.cursor = hovered ? "pointer" : "grab";
    if (hovered) showTooltip(hovered, mx, my);
    else tooltip.hidden = true;
  }

  function onClick() {
    if (!hovered || !hovered.rec) return;
    const id = hovered.rec.signal.mention_id;
    const card = document.querySelector(`[data-mention-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("flash");
      void card.offsetWidth;                    // restart animation
      card.classList.add("flash");
    }
  }

  function wire() {
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      return [src.clientX - r.left, src.clientY - r.top];
    };
    canvas.addEventListener("mousedown", (e) => { dragging = true; [lastX, lastY] = pos(e); });
    window.addEventListener("mouseup", () => { dragging = false; });
    canvas.addEventListener("mousemove", (e) => onMove(...pos(e)));
    canvas.addEventListener("mouseleave", () => { hovered = null; tooltip.hidden = true; });
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("touchstart", (e) => {
      [lastX, lastY] = pos(e);
      const [mx, my] = pos(e);
      hovered = pick(mx, my);
      if (hovered) { showTooltip(hovered, mx, my); e.preventDefault(); }
      else dragging = true;
    }, { passive: false });
    canvas.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const [mx, my] = pos(e);
      rotY += (mx - lastX) * 0.006;
      targetRotX = Math.max(-0.9, Math.min(0.9, targetRotX + (my - lastY) * 0.004));
      lastX = mx; lastY = my;
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener("touchend", () => {
      if (hovered) onClick();
      dragging = false;
      setTimeout(() => { tooltip.hidden = true; hovered = null; }, 1600);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = null; }
      else if (!raf) frame();
    });
  }

  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.floor(box.width);
    H = Math.floor(box.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ── public API ─────────────────────────────────────────── */

  function init(signals, prices) {
    canvas = document.getElementById("constellation");
    tooltip = document.getElementById("ct-tooltip");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resize();
    window.addEventListener("resize", () => { resize(); });
    build(signals, prices);
    wire();
    if (!raf) frame();
    if (reduced) draw();
  }

  return { init };
})();
