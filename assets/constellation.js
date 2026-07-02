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
  const FOCAL = 290;           // shorter focal length = stronger perspective
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
    return { x: Math.cos(th) * rad * r, y: y * r * 0.85, z: Math.sin(th) * rad * r };
  }

  function orbitPlane(seed) {
    // deterministic tilted orbit plane: two orthonormal basis vectors
    const a = Math.sin(seed * 12.9898) * 43758.5453;
    const b = Math.sin(seed * 78.233) * 12543.117;
    const ax = { x: Math.sin(a), y: 0.55 + 0.45 * Math.sin(b), z: Math.cos(a) };
    const m = Math.hypot(ax.x, ax.y, ax.z);
    ax.x /= m; ax.y /= m; ax.z /= m;
    let u = { x: -ax.z, y: 0, z: ax.x };
    const mu = Math.hypot(u.x, u.y, u.z) || 1;
    u = { x: u.x / mu, y: u.y / mu, z: u.z / mu };
    const v = {
      x: ax.y * u.z - ax.z * u.y,
      y: ax.z * u.x - ax.x * u.z,
      z: ax.x * u.y - ax.y * u.x,
    };
    return { u, v };
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

    const byKey = new Map();   // casefolded key -> {label, members}
    for (const rec of signals) {
      const s = rec.signal;
      const ticker = s.tickers && s.tickers[0];
      const raw = ticker || (s.entities && s.entities[0]) || "—";
      const key = ticker ? raw : raw.toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, {
          label: ticker ? raw : raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase(),
          members: [],
        });
      }
      byKey.get(key).members.push(rec);
    }

    const keys = [...byKey.keys()];
    keys.forEach((key, i) => {
      const { label, members } = byKey.get(key);
      const p = fibonacciSphere(i, keys.length, 132);
      const hub = {
        ...p, label, members,
        size: 3.6 + Math.min(members.length * 1.2, 7),
        color: "hub", green: 0, phase: Math.random() * TAU,
        shells: [],
      };
      // up to 3 tilted orbital shells; more mentions -> more populated shells
      const nShells = Math.min(3, Math.ceil(members.length / 3));
      for (let sh = 0; sh < nShells; sh++) {
        hub.shells.push({ ...orbitPlane(i * 3.7 + sh * 1.31), r: 30 + sh * 13 });
      }
      hubs.push(hub);
      members.forEach((rec, j) => {
        const s = rec.signal;
        const xs = latestExcess(prices, s.mention_id);
        const shell = hub.shells[j % hub.shells.length];
        const base = s.priority === "P1" ? 4.8 : s.priority === "P2" ? 3.9 : 3.1;
        const node = {
          hub, shell,
          orbitPhase: (Math.floor(j / hub.shells.length) /
            Math.max(1, Math.ceil(members.length / hub.shells.length))) * TAU + j * 0.35,
          speed: (0.0045 + (j % 4) * 0.0011) * (j % 2 ? 1 : -1),
          x: 0, y: 0, z: 0,   // filled per-frame from the orbit
          rec, size: base * (0.75 + 0.5 * Number(s.confidence || 0.5)),
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

    // hubs first (nodes orbit around their hub's animated position)
    const projected = [];
    for (const h of hubs) {
      h._w = bob(h, h.phase);
      h._p = project(h._w, cy, sy, cx, sx);
      projected.push(h);
    }
    for (const n of nodes) {
      const th = n.orbitPhase + (reduced ? 0 : t * n.speed);
      const { u, v } = n.shell, r = n.shell.r, c = n.hub._w;
      n._w = {
        x: c.x + (u.x * Math.cos(th) + v.x * Math.sin(th)) * r,
        y: c.y + (u.y * Math.cos(th) + v.y * Math.sin(th)) * r,
        z: c.z + (u.z * Math.cos(th) + v.z * Math.sin(th)) * r,
      };
      n._p = project(n._w, cy, sy, cx, sx);
      projected.push(n);
    }

    // orbit rings: faint projected ellipses make the geometry legible as 3D
    for (const h of hubs) {
      if (!h.shells || !h.shells.length) continue;
      for (const sh of h.shells) {
        ctx.strokeStyle = rgba(h.green ? "green" : "faint", h.green ? 0.10 : 0.08);
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (let k = 0; k <= 36; k++) {
          const a = (k / 36) * TAU;
          const p = project({
            x: h._w.x + (sh.u.x * Math.cos(a) + sh.v.x * Math.sin(a)) * sh.r,
            y: h._w.y + (sh.u.y * Math.cos(a) + sh.v.y * Math.sin(a)) * sh.r,
            z: h._w.z + (sh.u.z * Math.cos(a) + sh.v.z * Math.sin(a)) * sh.r,
          }, cy, sy, cx, sx);
          if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
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
      // sphere shading: off-center highlight -> body color -> darker limb
      const [cr, cg, cb] = COLORS[n.color];
      const grad = ctx.createRadialGradient(
        p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
      grad.addColorStop(0, `rgba(${cr + (255 - cr) * 0.75},${cg + (255 - cg) * 0.75},${cb + (255 - cb) * 0.75},${alpha})`);
      grad.addColorStop(0.55, rgba(n.color, alpha));
      grad.addColorStop(1, `rgba(${cr * 0.35},${cg * 0.35},${cb * 0.35},${alpha * 0.9})`);
      ctx.fillStyle = grad;
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
        const tag = n.members && n.members.length > 1
          ? `${n.label} ×${n.members.length}` : n.label;
        ctx.fillText(tag, p.x, p.y - r - 7);
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
