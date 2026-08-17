/* agent-sessions dashboard — vanilla JS, no dependencies.
   Charts are inline SVG built against the validated categorical slots exposed
   as CSS custom properties, so light/dark swap in one place. */

const SVG_NS = "http://www.w3.org/2000/svg";
const AGENT_SERIES = { claude: "var(--series-1)", codex: "var(--series-2)" };
const AGENT_ORDER = ["claude", "codex"];

const state = {
  agents: new Set(),          // empty === no agent filter
  project: "",
  days: "",
  metric: "tokens",
  meta: null,
  sessions: [],               // sidebar + palette cache
  activeKey: "",
  sessionTotal: 0,
  sessionSort: { key: "started", order: "desc" },
};

/* ---------- small helpers ---------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};
const svg = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmtNum = (n) => {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "K";
  return String(Math.round(n));
};

/** Percent of a total, never rounding a real value down to a bare "0%". */
const fmtPct = (value, total) => {
  if (!total) return "";
  const p = (value / total) * 100;
  if (p === 0) return "0%";
  if (p < 0.1) return "<0.1%";
  if (p < 1) return p.toFixed(1) + "%";
  return p.toFixed(0) + "%";
};

const fmtCost = (n) => {
  n = Number(n) || 0;
  if (n === 0) return "$0";
  if (n < 1) return "$" + n.toFixed(2);
  if (n < 1000) return "$" + n.toFixed(0);
  return "$" + (n / 1000).toFixed(1) + "k";
};
const fmtCostExact = (n) =>
  "$" + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtDur = (s) => {
  s = Number(s) || 0;
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  const h = s / 3600;
  return h < 48 ? h.toFixed(1) + "h" : Math.round(h / 24) + "d";
};
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "2-digit" });
};
const fmtDateTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString(undefined,
    { hour: "2-digit", minute: "2-digit" });
};

async function api(path, params = {}, options = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== "" && v !== null && v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url, options);
  const body = await res.json();
  if (body && body.error) throw new Error(body.error);
  return body;
}

function filterParams() {
  const p = { project: state.project };
  if (state.agents.size === 1) p.agent = [...state.agents][0];
  if (state.days) {
    const since = new Date(Date.now() - Number(state.days) * 864e5);
    p.since = since.toISOString().slice(0, 10);
  }
  return p;
}

function toast(msg, ms = 2600) {
  const node = $("#toast");
  node.textContent = msg;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (node.hidden = true), ms);
}

const typingInField = () => {
  const t = document.activeElement;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
               t.tagName === "SELECT" || t.isContentEditable);
};

/* ---------- shared tooltip --------------------------------------------- */

const tip = {
  node: null,
  show(html, evt) {
    this.node ??= $("#tooltip");
    this.node.innerHTML = html;
    this.node.hidden = false;
    this.move(evt);
  },
  move(evt) {
    if (!this.node || this.node.hidden) return;
    const pad = 14;
    const r = this.node.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    this.node.style.left = Math.max(8, x) + "px";
    this.node.style.top = Math.max(8, y) + "px";
  },
  hide() { if (this.node) this.node.hidden = true; },
};

const tipRows = (title, rows) =>
  `<div class="tt-title">${esc(title)}</div>` +
  rows.map(([k, v, color]) =>
    `<div class="tt-row"><span class="k">${
      color ? `<span class="swatch" style="background:${color}"></span>` : ""
    }${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");

/* ---------- chart primitives ------------------------------------------- */

/** Bar path with rounded ends on the far side only, anchored to the baseline. */
function barPath(x, y, w, h, r, dir = "up") {
  r = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0.01) return "";
  if (r < 0.5) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  if (dir === "up") {
    return `M${x} ${y + h}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}` +
           `a${r} ${r} 0 0 1 ${r} ${r}V${y + h}Z`;
  }
  return `M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}` +
         `a${r} ${r} 0 0 1 ${-r} ${r}H${x}Z`;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag)
    .find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = 0; v <= max * 1.0001; v += step) out.push(v);
  return out;
}

/** Stacked daily bars over a continuous date axis. */
function activityChart(rows, metric) {
  const wrap = el("div");
  if (!rows.length) return el("div", { class: "empty", text: "No activity in range" });

  const byDay = new Map();
  for (const r of rows) {
    const day = byDay.get(r.day) ?? {};
    day[r.agent] = (day[r.agent] || 0) +
      (metric === "sessions" ? r.sessions : metric === "cost" ? r.cost_usd : r.tokens);
    byDay.set(r.day, day);
  }

  // Continuous axis: a gap in activity should read as a gap, not be collapsed.
  const days = [...byDay.keys()].sort();
  const start = new Date(days[0] + "T00:00:00Z");
  const end = new Date(days[days.length - 1] + "T00:00:00Z");
  const axis = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    axis.push(d.toISOString().slice(0, 10));
  }

  const W = 1100, H = 240;
  const M = { top: 8, right: 8, bottom: 22, left: 42 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const agents = AGENT_ORDER.filter((a) => rows.some((r) => r.agent === a));
  const totals = axis.map((d) => {
    const rec = byDay.get(d) || {};
    return agents.reduce((sum, a) => sum + (rec[a] || 0), 0);
  });
  const max = Math.max(...totals, 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const yOf = (v) => M.top + plotH - (v / top) * plotH;

  const slot = plotW / axis.length;
  const gap = slot > 4 ? 2 : slot > 2 ? 1 : 0.4;
  const bw = Math.max(slot - gap, 0.6);

  const root = svg("svg", {
    class: "chart", viewBox: `0 0 ${W} ${H}`, height: H,
    preserveAspectRatio: "none", role: "img",
    "aria-label": `Daily ${metric} by agent`,
  });

  for (const t of ticks) {
    root.append(svg("line", {
      class: "gridline", x1: M.left, x2: W - M.right, y1: yOf(t), y2: yOf(t),
    }));
    root.append(svg("text", {
      class: "tick", x: M.left - 8, y: yOf(t) + 3.5, "text-anchor": "end",
    }, document.createTextNode(metric === "cost" ? fmtCost(t) : fmtNum(t))));
  }

  axis.forEach((day, i) => {
    const rec = byDay.get(day) || {};
    const x = M.left + i * slot + gap / 2;
    let acc = 0;
    const segs = agents.map((a) => ({ a, v: rec[a] || 0 })).filter((s) => s.v > 0);
    segs.forEach((s, si) => {
      const y0 = yOf(acc);
      acc += s.v;
      const y1 = yOf(acc);
      const h = Math.max(y0 - y1, 1);
      const isTop = si === segs.length - 1;
      const inset = si > 0 ? Math.min(2, h - 0.5) : 0;   // 2px surface gap
      root.append(svg("path", {
        class: "mark",
        d: barPath(x, y1, bw, Math.max(h - inset, 0.8), isTop ? 4 : 0),
        fill: AGENT_SERIES[s.a],
      }));
    });
  });

  let lastMonth = "";
  axis.forEach((day, i) => {
    const month = day.slice(0, 7);
    if (month === lastMonth) return;
    lastMonth = month;
    const label = new Date(day + "T00:00:00Z")
      .toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
    root.append(svg("text", { class: "tick", x: M.left + i * slot + 1, y: H - 6 },
      document.createTextNode(label)));
  });

  root.append(svg("line", {
    class: "baseline", x1: M.left, x2: W - M.right,
    y1: M.top + plotH, y2: M.top + plotH,
  }));

  // Full-height hit targets: easier to hover than a 4px bar.
  axis.forEach((day, i) => {
    const rec = byDay.get(day) || {};
    const total = agents.reduce((s, a) => s + (rec[a] || 0), 0);
    const hit = svg("rect", {
      x: M.left + i * slot, y: M.top, width: Math.max(slot, 1), height: plotH,
      fill: "transparent", style: "cursor:crosshair",
    });
    hit.addEventListener("mouseenter", (e) => {
      const fmt = metric === "cost" ? fmtCostExact : (v) => fmtNum(v) +
        (metric === "sessions" ? "" : " tok");
      const rowsOut = agents.filter((a) => rec[a])
        .map((a) => [a, fmt(rec[a]), AGENT_SERIES[a]]);
      if (!rowsOut.length) rowsOut.push(["no activity", "—", null]);
      else if (rowsOut.length > 1) rowsOut.push(["total", fmt(total), null]);
      tip.show(tipRows(new Date(day + "T00:00:00Z").toLocaleDateString(undefined,
        { weekday: "short", month: "short", day: "numeric", year: "numeric",
          timeZone: "UTC" }), rowsOut), e);
    });
    hit.addEventListener("mousemove", (e) => tip.move(e));
    hit.addEventListener("mouseleave", () => tip.hide());
    root.append(hit);
  });

  wrap.append(root);
  return wrap;
}

/** One horizontal bar split into labelled segments (token composition). */
function compositionBar(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const wrap = el("div");
  if (!total) return el("div", { class: "empty", text: "No token data" });

  const W = 1000, H = 14, R = 3, GAP = 2;
  const root = svg("svg", {
    class: "chart", viewBox: `0 0 ${W} ${H}`, height: H,
    preserveAspectRatio: "none", role: "img", "aria-label": "Token composition",
  });

  const visible = segments.filter((s) => s.value > 0);
  let x = 0;
  visible.forEach((s, i) => {
    const raw = (s.value / total) * W;
    const w = Math.max(raw - (i < visible.length - 1 ? GAP : 0), 1);
    const first = i === 0, last = i === visible.length - 1;
    let d;
    if (first && last) d = barPath(x, 0, w, H, R, "right");
    else if (first) d = `M${x + R} 0h${w - R}v${H}h${-(w - R)}a${R} ${R} 0 0 1 ${-R} ${-R}V${R}a${R} ${R} 0 0 1 ${R} ${-R}Z`;
    else if (last) d = barPath(x, 0, w, H, R, "right");
    else d = `M${x} 0h${w}v${H}h${-w}Z`;
    const path = svg("path", { class: "mark", d, fill: s.color });
    path.addEventListener("mouseenter", (e) => tip.show(tipRows(s.label, [
      ["tokens", s.value.toLocaleString(), s.color],
      ["share", fmtPct(s.value, total), null],
    ]), e));
    path.addEventListener("mousemove", (e) => tip.move(e));
    path.addEventListener("mouseleave", () => tip.hide());
    root.append(path);
    x += raw;
  });

  // Direct labels: also the relief for sub-3:1 slots on the light surface.
  const legend = el("div", { class: "legend" },
    segments.map((s) => el("span", { class: "item" },
      el("span", { class: "swatch", style: `background:${s.color}` }),
      el("span", { class: "k", text: s.label }),
      el("span", { class: "v", text: fmtNum(s.value) }),
      el("span", { class: "k", text: fmtPct(s.value, total) }),
    )));

  wrap.append(root, legend);
  return wrap;
}

/** Ranked horizontal bars for a single measure (no colour-as-identity). */
function rankedBars(rows, { label, value, format = fmtNum, sub }) {
  if (!rows.length) return el("div", { class: "empty", text: "Nothing to show" });
  const max = Math.max(...rows.map((r) => Number(value(r)) || 0), 1);
  const list = el("div", { class: "ranked" });
  for (const r of rows) {
    const v = Number(value(r)) || 0;
    const pct = Math.max((v / max) * 100, 0.6);
    const row = el("div", { class: "ranked-row" },
      el("div", { class: "ranked-label", title: label(r), text: label(r) }),
      el("div", { class: "ranked-track" },
        el("div", { class: "ranked-bar", style: `width:${pct}%` })),
      el("div", { class: "ranked-value", text: format(v) }),
    );
    if (sub) {
      row.addEventListener("mouseenter", (e) => tip.show(tipRows(label(r), sub(r)), e));
      row.addEventListener("mousemove", (e) => tip.move(e));
      row.addEventListener("mouseleave", () => tip.hide());
    }
    list.append(row);
  }
  return list;
}

/** Hour-of-day histogram (24 bars, one measure). */
function hourHistogram(rows) {
  const counts = new Array(24).fill(0);
  for (const r of rows) if (r.hour != null) counts[r.hour] = r.sessions;
  const max = Math.max(...counts, 1);

  const W = 480, H = 106, M = { top: 6, right: 4, bottom: 18, left: 4 };
  const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
  const slot = plotW / 24, bw = Math.max(slot - 3, 2);

  const root = svg("svg", {
    class: "chart", viewBox: `0 0 ${W} ${H}`, height: H,
    preserveAspectRatio: "none", role: "img",
    "aria-label": "Sessions started by hour of day",
  });

  counts.forEach((c, h) => {
    const bh = (c / max) * plotH;
    const x = M.left + h * slot + (slot - bw) / 2;
    if (bh > 0.5) {
      root.append(svg("path", {
        class: "mark", d: barPath(x, M.top + plotH - bh, bw, bh, 3),
        fill: "var(--series-1)",
      }));
    }
    const hit = svg("rect", {
      x: M.left + h * slot, y: M.top, width: slot, height: plotH,
      fill: "transparent", style: "cursor:crosshair",
    });
    const lbl = `${String(h).padStart(2, "0")}:00`;
    hit.addEventListener("mouseenter", (e) => tip.show(tipRows(lbl,
      [["sessions started", String(c), "var(--series-1)"]]), e));
    hit.addEventListener("mousemove", (e) => tip.move(e));
    hit.addEventListener("mouseleave", () => tip.hide());
    root.append(hit);
  });

  for (const h of [0, 6, 12, 18]) {
    root.append(svg("text", {
      class: "tick", x: M.left + h * slot + slot / 2, y: H - 5,
      "text-anchor": "middle",
    }, document.createTextNode(String(h).padStart(2, "0"))));
  }
  root.append(svg("line", {
    class: "baseline", x1: M.left, x2: W - M.right,
    y1: M.top + plotH, y2: M.top + plotH,
  }));
  return root;
}

/* ---------- view pieces ------------------------------------------------- */

function tile(label, value, unit, meta) {
  return el("div", { class: "card tile" },
    el("div", { class: "label", text: label }),
    el("div", { class: "value" }, String(value),
      unit ? el("span", { class: "unit", text: unit }) : null),
    meta ? el("div", { class: "meta", text: meta }) : null);
}

function card(title, sub, ...body) {
  return el("div", { class: "card" },
    el("h2", { text: title }),
    sub ? el("p", { class: "sub", text: sub }) : null,
    ...body);
}

/** The page title lives in the topbar, so views set it rather than render it. */
function setPage(title, sub) {
  $("#pageTitle").textContent = title;
  $("#pageSub").textContent = sub || "";
}

/* ---------- views ------------------------------------------------------- */

async function viewOverview(root) {
  root.replaceChildren(el("div", { class: "empty", text: "Loading…" }));
  const data = await api("/api/overview", filterParams());
  const t = data.totals;
  setPage("Dashboard", "Here's a snapshot of your agent activity.");
  renderKpis(t, data.by_day);
  root.replaceChildren();

  const unpricedNote = t.unpriced
    ? `${t.unpriced} session${t.unpriced > 1 ? "s" : ""} on unpriced models`
    : "at API list rates";

  const metricBar = el("div", { class: "toolbar" },
    ...["tokens", "sessions", "cost"].map((m) =>
      el("button", {
        class: "chip", "aria-pressed": String(state.metric === m),
        text: m[0].toUpperCase() + m.slice(1),
        onclick: () => { state.metric = m; render(); },
      })));

  const legend = el("div", { class: "legend" },
    ...data.by_agent.map((a) => el("span", { class: "item" },
      el("span", { class: "swatch",
        style: `background:${AGENT_SERIES[a.agent] || "var(--muted)"}` }),
      el("span", { class: "k", text: a.agent }),
      el("span", { class: "v", text: `${a.sessions} sessions` }))));

  root.append(el("div", { class: "grid thirds" },
    card("Activity over time", "Daily totals, stacked by agent",
      metricBar, activityChart(data.by_day, state.metric), legend),
    card("Recent sessions", `${state.sessionTotal || 0} in scope`,
      recentSessions())));

  root.append(el("div", { class: "grid halves", style: "margin-top:16px" },
    card("Spend & token mix",
      `${unpricedNote} — cache reads bill at ~10% of the input rate`,
      el("div", { class: "bignum", text: fmtCostExact(t.cost_usd) }),
      compositionBar([
        { label: "Input", value: t.input_tokens, color: "var(--series-1)" },
        { label: "Output", value: t.output_tokens, color: "var(--series-2)" },
        { label: "Cache read", value: t.cache_read, color: "var(--series-3)" },
        { label: "Cache write", value: t.cache_write, color: "var(--series-4)" },
      ])),
    card("When you work", "Sessions started, by hour of day",
      hourHistogram(data.by_hour)),
  ));

  root.append(el("div", { class: "grid halves", style: "margin-top:16px" },
    card("Projects", "By total tokens",
      rankedBars(data.by_project, {
        label: (r) => r.project || "(unknown)",
        value: (r) => r.tokens,
        sub: (r) => [
          ["sessions", String(r.sessions)],
          ["tokens", Number(r.tokens).toLocaleString()],
          ["est. cost", fmtCostExact(r.cost_usd)],
        ],
      })),
    card("Models", "By total tokens",
      rankedBars(data.by_model, {
        label: (r) => r.model || "(unknown)",
        value: (r) => r.tokens,
        sub: (r) => [
          ["agent", r.agent],
          ["sessions", String(r.sessions)],
          ["tokens", Number(r.tokens).toLocaleString()],
          ["est. cost", r.cost_usd ? fmtCostExact(r.cost_usd) : "no price set"],
        ],
      })),
  ));

  if (data.top_tools.length) {
    root.append(el("div", { class: "grid", style: "margin-top:16px" },
      card("Tools used", "Across all indexed sessions",
        rankedBars(data.top_tools, {
          label: (r) => r.tool_name, value: (r) => r.n,
          format: (v) => v.toLocaleString(),
        }))));
  }
}

const SESSION_COLUMNS = [
  { key: "title", label: "Session", sort: null },
  { key: "agent", label: "Agent", sort: null },
  { key: "project", label: "Project", sort: null },
  { key: "started", label: "Started", sort: "started", num: true },
  { key: "duration", label: "Duration", sort: "duration", num: true },
  { key: "messages", label: "Msgs", sort: "messages", num: true },
  { key: "tools", label: "Tools", sort: "tools", num: true },
  { key: "tokens", label: "Tokens", sort: "tokens", num: true },
  { key: "cost", label: "Est. cost", sort: "cost", num: true },
];

async function viewSessions(root) {
  root.replaceChildren(el("div", { class: "empty", text: "Loading…" }));
  const data = await api("/api/sessions", {
    ...filterParams(),
    sort: state.sessionSort.key, order: state.sessionSort.order, limit: 100,
  });
  setPage("All sessions", data.total > data.sessions.length
    ? `${data.total} sessions — showing the first ${data.sessions.length}`
    : `${data.total} sessions`);
  root.replaceChildren();

  const head = el("tr", {}, ...SESSION_COLUMNS.map((c) =>
    el("th", {
      class: [c.sort ? "sortable" : "", c.num ? "num" : "",
        state.sessionSort.key === c.sort ? "sorted" : ""].join(" ").trim(),
      text: c.label + (state.sessionSort.key === c.sort
        ? (state.sessionSort.order === "desc" ? " ↓" : " ↑") : ""),
      onclick: c.sort ? () => {
        const s = state.sessionSort;
        if (s.key === c.sort) s.order = s.order === "desc" ? "asc" : "desc";
        else { s.key = c.sort; s.order = "desc"; }
        render();
      } : null,
    })));

  const body = el("tbody", {}, ...data.sessions.map((s) =>
    el("tr", { class: "row", onclick: () => go(`#/session/${encodeURIComponent(s.key)}`) },
      el("td", { class: "wrapcell" },
        el("div", { class: "title-cell", text: s.title || "(untitled)" }),
        s.first_prompt
          ? el("div", { class: "dim", style: "font-size:11px;margin-top:2px" },
              s.first_prompt.slice(0, 110).replace(/\s+/g, " "))
          : null),
      el("td", {}, el("span", { class: "badge" },
        el("span", { class: "dot",
          style: `background:${AGENT_SERIES[s.agent] || "var(--muted)"}` }),
        s.agent)),
      el("td", { class: "dim" }, s.project || "—"),
      el("td", { class: "num dim" }, fmtDate(s.started_at)),
      el("td", { class: "num dim" }, s.duration_s ? fmtDur(s.duration_s) : "—"),
      el("td", { class: "num" }, fmtNum(s.n_messages)),
      el("td", { class: "num" }, fmtNum(s.n_tool_calls)),
      el("td", { class: "num" }, fmtNum(s.total_tokens)),
      el("td", { class: "num" }, s.unpriced && !s.cost_usd ? "—" : fmtCost(s.cost_usd)),
    )));

  root.append(el("div", { class: "card table-card" },
    el("div", { class: "table-scroll" },
      el("table", {}, el("thead", {}, head), body))));
}

async function viewSession(root, key) {
  root.replaceChildren(el("div", { class: "empty", text: "Loading…" }));
  const s = await api(`/api/session/${encodeURIComponent(key)}`);
  root.replaceChildren();

  root.append(el("div", { class: "toolbar" },
    el("a", { class: "backlink", href: "#/sessions", text: "← All sessions" })));

  const meta = el("div", { class: "meta-grid" },
    el("div", {}, "Agent ", el("b", { text: s.agent })),
    s.model ? el("div", {}, "Model ", el("b", { text: s.model })) : null,
    s.project ? el("div", {}, "Project ", el("b", { text: s.project })) : null,
    s.git_branch ? el("div", {}, "Branch ", el("b", { text: s.git_branch })) : null,
    el("div", {}, "Started ", el("b", { text: fmtDateTime(s.started_at) || "—" })),
    s.duration_s ? el("div", {}, "Duration ", el("b", { text: fmtDur(s.duration_s) })) : null,
    s.n_subagents ? el("div", {}, "Subagents ", el("b", { text: String(s.n_subagents) })) : null,
    s.version ? el("div", {}, "Version ", el("b", { text: s.version })) : null,
  );

  setPage(s.title || "(untitled session)", s.cwd || "");
  root.append(el("div", { class: "card" }, meta));

  root.append(el("div", { class: "grid tiles", style: "margin-top:14px" },
    tile("Messages", fmtNum(s.n_messages), "",
      `${s.n_user} prompts · ${s.n_tool_calls} tool calls`),
    tile("Tokens", fmtNum(s.total_tokens), "", `${fmtNum(s.output_tokens)} generated`),
    tile("Est. cost", s.unpriced && !s.cost_usd ? "—" : fmtCostExact(s.cost_usd || 0), "",
      s.unpriced ? "model has no price set" : "at API list rates"),
  ));

  if (s.total_tokens) {
    root.append(el("div", { class: "grid", style: "margin-top:16px" },
      card("Token composition", "",
        compositionBar([
          { label: "Input", value: s.input_tokens, color: "var(--series-1)" },
          { label: "Output", value: s.output_tokens, color: "var(--series-2)" },
          { label: "Cache read", value: s.cache_read, color: "var(--series-3)" },
          { label: "Cache write", value: s.cache_write, color: "var(--series-4)" },
        ]))));
  }

  if (s.tools?.length) {
    const TOP = 12;
    const shown = s.tools.slice(0, TOP);
    const rest = s.tools.length - shown.length;
    root.append(el("div", { class: "grid", style: "margin-top:16px" },
      card("Tools in this session",
        rest > 0 ? `Top ${TOP} of ${s.tools.length} distinct tools` : "",
        rankedBars(shown, {
          label: (r) => r.tool_name, value: (r) => r.n,
          format: (v) => v.toLocaleString(),
        }))));
  }

  const kinds = ["", ...s.kinds.map((k) => k.kind)];
  const controls = el("div", { class: "toolbar" });
  const filterState = {
    kind: "", q: "", offset: 0,
    raw: localStorage.getItem("as-raw") === "1",
  };
  const list = el("div");
  const moreWrap = el("div", { style: "margin-top:12px" });

  const kindSelect = el("select", { class: "select", style: "width:auto",
    onchange: (e) => {
      filterState.kind = e.target.value; filterState.offset = 0; loadMessages(true);
    } },
    ...kinds.map((k) => el("option", { value: k },
      k ? `${k} (${s.kinds.find((x) => x.kind === k).n})` : `all (${s.n_messages})`)));

  const search = el("input", {
    class: "searchbox", style: "max-width:260px", placeholder: "Filter transcript…",
    oninput: (e) => {
      clearTimeout(search._t);
      search._t = setTimeout(() => {
        filterState.q = e.target.value; filterState.offset = 0; loadMessages(true);
      }, 260);
    },
  });

  const rawToggle = el("button", {
    class: "chip", "aria-pressed": String(filterState.raw), text: "Raw text",
    title: "Show the exact stored text instead of rendered markdown and code",
    onclick: (e) => {
      filterState.raw = !filterState.raw;
      localStorage.setItem("as-raw", filterState.raw ? "1" : "0");
      e.currentTarget.setAttribute("aria-pressed", String(filterState.raw));
      filterState.offset = 0;
      loadMessages(true);
    },
  });
  controls.append(kindSelect, search, rawToggle, exportMenu(s));

  async function loadMessages(reset) {
    if (reset) list.replaceChildren();
    const res = await api(`/api/session/${encodeURIComponent(key)}/messages`, {
      kind: filterState.kind, q: filterState.q,
      limit: 150, offset: filterState.offset,
    });
    for (const m of res.messages) list.append(messageNode(m, filterState.raw));
    if (!res.messages.length && reset) {
      list.append(el("div", { class: "empty", text: "No messages match" }));
    }
    filterState.offset += res.messages.length;
    moreWrap.replaceChildren();
    if (filterState.offset < res.total) {
      moreWrap.append(el("button", {
        class: "btn",
        text: `Load more (${res.total - filterState.offset} remaining)`,
        onclick: () => loadMessages(false),
      }));
    }
  }

  root.append(el("div", { style: "margin-top:14px" },
    card("Transcript", `${s.n_messages} messages`, controls, list, moreWrap)));
  loadMessages(true);
}

/* ---------- export ------------------------------------------------------ */

/**
 * Every message in the session, not just the page the viewer has scrolled to.
 * The transcript view loads 150 at a time; an export that only captured those
 * would silently be a fragment.
 */
async function fetchAllMessages(key, onProgress) {
  const all = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const res = await api(`/api/session/${encodeURIComponent(key)}/messages`,
      { limit: 1000, offset });
    total = res.total;
    all.push(...res.messages);
    offset += res.messages.length;
    if (!res.messages.length) break;          // guard against a stuck cursor
    if (onProgress) onProgress(all.length, total);
  }
  return all;
}

function downloadBlob(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportSession(session, format) {
  const R = window.AS_RENDER;
  toast("Collecting the full transcript…", 60000);
  let messages;
  try {
    messages = await fetchAllMessages(session.key, (n, total) => {
      if (total > 1200) toast(`Collecting transcript… ${n}/${total}`, 60000);
    });
  } catch (err) {
    return toast("Export failed: " + err.message, 5000);
  }

  try {
    if (format === "copy") {
      const md = R.sessionToMarkdown(session, messages);
      await navigator.clipboard.writeText(md);
      toast(`Copied ${messages.length} messages as Markdown`);
    } else if (format === "md") {
      downloadBlob(R.sessionToMarkdown(session, messages),
        R.exportFilename(session, "md"), "text/markdown;charset=utf-8");
      toast(`Exported ${messages.length} messages as Markdown`);
    } else if (format === "html") {
      downloadBlob(R.sessionToHtml(session, messages),
        R.exportFilename(session, "html"), "text/html;charset=utf-8");
      toast(`Exported ${messages.length} messages as HTML`);
    } else if (format === "pdf") {
      // No PDF library ships with this tool, so the export is a print-styled
      // document handed to the browser's own PDF writer.
      const win = window.open("", "_blank");
      if (!win) {
        return toast("Allow pop-ups for this site to print to PDF", 5000);
      }
      win.document.write(R.sessionToHtml(session, messages));
      win.document.close();
      win.addEventListener("load", () => setTimeout(() => win.print(), 250));
      toast("Opened print view — choose “Save as PDF”");
    }
  } catch (err) {
    toast("Export failed: " + err.message, 5000);
  }
}

/** Small dropdown of export actions, anchored to its trigger button. */
function exportMenu(session) {
  const items = [
    ["copy", "Copy as Markdown"],
    ["md", "Download Markdown (.md)"],
    ["html", "Download HTML (.html)"],
    ["pdf", "Print / Save as PDF"],
  ];
  const menu = el("div", { class: "menu", hidden: "" },
    ...items.map(([fmt, label]) => el("button", {
      class: "menu-item", text: label,
      onclick: () => { close(); exportSession(session, fmt); },
    })));

  const btn = el("button", {
    class: "btn", text: "Export ▾",
    onclick: (e) => {
      e.stopPropagation();
      menu.hidden ? open() : close();
    },
  });

  // Attached immediately, not on a timer: the opening click bubbles to the
  // document too, but `wrap.contains` already ignores clicks inside the menu.
  function open() {
    menu.hidden = false;
    document.addEventListener("click", onAway);
    document.addEventListener("keydown", onEsc);
  }
  function close() {
    menu.hidden = true;
    document.removeEventListener("click", onAway);
    document.removeEventListener("keydown", onEsc);
  }
  const onAway = (e) => { if (!wrap.contains(e.target)) close(); };
  const onEsc = (e) => { if (e.key === "Escape") close(); };

  const wrap = el("div", { class: "menu-wrap" }, btn, menu);
  return wrap;
}

/** Message body: markdown for prose, syntax-highlighted code for tool traffic. */
function messageBody(m, raw) {
  const R = window.AS_RENDER;
  if (raw || !R) return el("pre", { text: m.text || "" });

  const body = el("div", { class: "rendered" });
  try {
    if (m.kind === "tool_use") {
      body.innerHTML = R.renderToolUse(m.tool_name, m.text || "");
    } else if (m.kind === "tool_result") {
      body.innerHTML = R.renderToolResult(m.text || "");
    } else if (m.role === "system") {
      body.innerHTML = R.renderSystem(m.text || "");
    } else {
      body.innerHTML = R.renderMarkdown(m.text || "");
    }
  } catch {
    // Never let a rendering bug hide the message — fall back to plain text.
    return el("pre", { text: m.text || "" });
  }
  return body;
}

function messageNode(m, raw) {
  const who = m.kind === "tool_use" ? (m.tool_name || "tool")
    : m.kind === "tool_result" ? "result"
    : m.kind === "thinking" ? "thinking"
    : m.role;
  return el("div", { class: `msg ${m.kind === "thinking" ? "thinking" : m.role}` },
    el("div", { class: "gutter" },
      el("span", { class: "who", text: who }),
      el("span", { class: "when", text: fmtTime(m.ts) }),
      m.sidechain
        ? el("span", { class: "when sidetag", text: m.label || "subagent" })
        : null),
    el("div", { class: "body" },
      m.kind === "tool_use" || m.kind === "tool_result"
        ? el("span", { class: "kindtag", text: m.kind }) : null,
      messageBody(m, raw),
      m.truncated
        ? el("span", { class: "more", text: "… truncated in the index" }) : null),
  );
}

async function viewSearch(root) {
  setPage("Search", state.meta?.fts
    ? "Full-text search across every indexed message"
    : "Substring search — FTS5 unavailable in this SQLite build");
  root.replaceChildren();

  const initial = new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
  const results = el("div");

  const input = el("input", {
    class: "searchbox", placeholder: "Search every message across all sessions…",
    value: initial, autofocus: "",
    oninput: (e) => {
      clearTimeout(input._t);
      input._t = setTimeout(() => run(e.target.value), 280);
    },
  });

  root.append(el("div", { class: "card" }, input, results));

  async function run(q) {
    if (!q.trim()) { results.replaceChildren(); return; }
    results.replaceChildren(el("div", { class: "empty", text: "Searching…" }));
    const params = { q, limit: 80 };
    if (state.agents.size === 1) params.agent = [...state.agents][0];
    const data = await api("/api/search", params);
    results.replaceChildren();
    if (!data.results.length) {
      results.append(el("div", { class: "empty", text: `No matches for “${q}”` }));
      return;
    }
    results.append(el("p", { class: "sub", style: "margin:12px 0 4px",
      text: `${data.results.length} matching messages` }));
    for (const r of data.results) {
      // FTS snippets arrive delimited with ‹ › so they can be escaped first.
      const snip = esc(r.snip || "").replace(/‹/g, "<mark>").replace(/›/g, "</mark>");
      results.append(el("a", {
        class: "hitrow", href: `#/session/${encodeURIComponent(r.session_key)}`,
      },
        el("div", { class: "hit-title" },
          el("span", { class: "badge" },
            el("span", { class: "dot",
              style: `background:${AGENT_SERIES[r.agent] || "var(--muted)"}` }),
            r.agent),
          " ", r.title || "(untitled)",
          el("span", { class: "dim", text: `  ·  ${r.role}/${r.kind}` })),
        el("div", { class: "hit-snip", html: snip }),
      ));
    }
  }

  if (initial) run(initial);
}

/* ---------- session cache & KPI strip ----------------------------------- */

async function loadSessions() {
  try {
    const data = await api("/api/sessions", {
      ...filterParams(), sort: "started", order: "desc", limit: 400,
    });
    state.sessions = data.sessions;
    state.sessionTotal = data.total;
  } catch {
    state.sessions = [];
  }
}

/**
 * Change over the last 30 days vs the 30 before, from the daily series.
 * Returns null when there is no comparable earlier window, so the UI shows
 * nothing rather than inventing a baseline.
 */
function periodDelta(byDay, key) {
  const totals = new Map();
  for (const r of byDay) {
    totals.set(r.day, (totals.get(r.day) || 0) + (Number(r[key]) || 0));
  }
  const days = [...totals.keys()].sort();
  if (days.length < 4) return null;

  const end = new Date(days[days.length - 1] + "T00:00:00Z");
  const curFrom = new Date(end); curFrom.setUTCDate(curFrom.getUTCDate() - 29);
  const prevFrom = new Date(curFrom); prevFrom.setUTCDate(prevFrom.getUTCDate() - 30);

  let cur = 0, prev = 0, sawPrev = false;
  for (const [day, v] of totals) {
    const t = new Date(day + "T00:00:00Z");
    if (t >= curFrom) cur += v;
    else if (t >= prevFrom) { prev += v; sawPrev = true; }
  }
  if (!sawPrev || prev <= 0) return null;
  return (cur - prev) / prev;
}

function deltaBadge(d) {
  if (d === null) return null;
  // Past a doubling, "21x" is far more legible than "+2000%".
  const text = d >= 1 ? `${(1 + d).toFixed(1)}\u00d7`
    : `${d >= 0 ? "+" : "\u2212"}${Math.round(Math.abs(d) * 100)}%`;
  return el("span", { class: "delta " + (d >= 0 ? "up" : "down"), text });
}

function renderKpis(totals, byDay) {
  const box = $("#kpis");
  const rows = [
    { label: "Sessions", color: "var(--series-1)",
      value: String(totals.sessions), key: "sessions" },
    { label: "Tokens", color: "var(--series-3)",
      value: fmtNum(totals.total_tokens), key: "tokens" },
    { label: "Est. cost", color: "var(--accent-mark)",
      value: fmtCost(totals.cost_usd), key: "cost_usd" },
  ];
  box.replaceChildren(...rows.map((r) => {
    const d = periodDelta(byDay, r.key);
    const badge = deltaBadge(d);
    return el("div", { class: "kpi" },
      el("div", { class: "klabel" },
        el("span", { class: "kdot", style: `background:${r.color}` }),
        r.label),
      el("div", { class: "kval", text: r.value }),
      el("div", { class: "kfoot" },
        badge || el("span", { text: "—" }),
        badge ? " vs prev 30d" : " no earlier period"));
  }));
}

function recentSessions(limit = 8) {
  const rows = state.sessions.slice(0, limit);
  if (!rows.length) return el("div", { class: "empty", text: "No sessions" });
  return el("div", { class: "rowlist" }, ...rows.map((s) =>
    el("a", { class: "rowlink", href: `#/session/${encodeURIComponent(s.key)}` },
      el("span", { class: "rl-dot",
        style: `background:${AGENT_SERIES[s.agent] || "var(--muted)"}` }),
      el("span", { class: "rl-main" },
        el("div", { class: "rl-title", text: s.title || "(untitled)" }),
        el("div", { class: "rl-sub",
          text: `${s.project || "—"} · ${fmtDate(s.started_at)}` })),
      el("span", { class: "rl-val", text: fmtNum(s.total_tokens) }))));
}

async function buildFilters() {
  const meta = await api("/api/meta");
  state.meta = meta;

  $("#agentChips").replaceChildren(...meta.agents.map((a) =>
    el("button", {
      class: "chip",
      "aria-pressed": String(!state.agents.size || state.agents.has(a.agent)),
      onclick: async () => {
        // One agent selected = filter to it; all or none = no filter.
        if (state.agents.has(a.agent)) state.agents.delete(a.agent);
        else state.agents.add(a.agent);
        if (state.agents.size === meta.agents.length) state.agents.clear();
        await buildFilters();
        await loadSessions();
        render();
      },
    },
      el("span", { class: "dot",
        style: `background:${AGENT_SERIES[a.agent] || "var(--muted)"}` }),
      `${a.agent} ${a.n}`)));

  const all = await api("/api/sessions", { limit: 500, sort: "tokens" });
  const names = [...new Set(all.sessions.map((s) => s.project).filter(Boolean))].sort();
  $("#projectFilter").replaceChildren(
    el("option", { value: "" }, "All projects"),
    ...names.map((n) => el("option", { value: n, selected: n === state.project }, n)));

  $("#rowMeta").textContent =
    `${meta.total.n} sessions indexed · ${(meta.db_bytes / 1048576).toFixed(0)} MB`;
}

/* ---------- command palette --------------------------------------------- */

const palette = {
  items: [], sel: 0,
  open() {
    $("#paletteScrim").hidden = false;
    const input = $("#paletteInput");
    input.value = "";
    this.build("");
    input.focus();
  },
  close() { $("#paletteScrim").hidden = true; },
  isOpen() { return !$("#paletteScrim").hidden; },

  build(query) {
    const q = query.toLowerCase().trim();
    const commands = [
      { label: "Overview", meta: "view", run: () => go("#/overview") },
      { label: "All sessions", meta: "view", run: () => go("#/sessions") },
      { label: "Search messages", meta: "view", run: () => go("#/search") },
      { label: "Toggle light / dark", meta: "theme", run: toggleTheme },
      { label: "Refresh index", meta: "action", run: reindex },
    ].filter((c) => !q || c.label.toLowerCase().includes(q));

    const sessions = state.sessions
      .filter((s) => !q ||
        `${s.title || ""} ${s.project || ""}`.toLowerCase().includes(q))
      .slice(0, 40)
      .map((s) => ({
        label: s.title || "(untitled)",
        meta: `${s.project || "—"} · ${fmtNum(s.total_tokens)}`,
        color: AGENT_SERIES[s.agent] || "var(--muted)",
        run: () => go(`#/session/${encodeURIComponent(s.key)}`),
      }));

    this.items = [...commands, ...sessions];
    this.sel = 0;
    this.paint(commands.length);
  },

  paint(nCommands) {
    const list = $("#paletteList");
    list.replaceChildren();
    if (!this.items.length) {
      list.append(el("div", { class: "empty", text: "No matches" }));
      return;
    }
    this.items.forEach((item, i) => {
      if (i === 0 && nCommands) list.append(el("div", { class: "pgroup", text: "Go to" }));
      if (i === nCommands) list.append(el("div", { class: "pgroup", text: "Sessions" }));
      list.append(el("div", {
        class: "pitem", "aria-selected": String(i === this.sel), "data-i": i,
        onmouseenter: () => { this.sel = i; this.highlight(); },
        onclick: () => { this.close(); item.run(); },
      },
        el("span", { class: "pdot",
          style: `background:${item.color || "var(--muted)"}` }),
        el("span", { class: "plabel", text: item.label }),
        el("span", { class: "pmeta", text: item.meta || "" })));
    });
  },

  highlight() {
    for (const node of document.querySelectorAll(".pitem")) {
      const on = Number(node.dataset.i) === this.sel;
      node.setAttribute("aria-selected", String(on));
      if (on) node.scrollIntoView({ block: "nearest" });
    }
  },

  move(delta) {
    if (!this.items.length) return;
    this.sel = (this.sel + delta + this.items.length) % this.items.length;
    this.highlight();
  },

  choose() {
    const item = this.items[this.sel];
    if (!item) return;
    this.close();
    item.run();
  },
};

/* ---------- chrome ------------------------------------------------------ */

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const dark = cur ? cur === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("as-theme", next);
}

async function reindex() {
  const btn = $("#reindex");
  btn.disabled = true;
  btn.classList.add("spin");
  try {
    const s = await api("/api/reindex", {}, { method: "POST" });
    toast(`Indexed ${s.indexed}, unchanged ${s.skipped} · ${s.elapsed.toFixed(1)}s`);
    await buildFilters();
    await loadSessions();
    render();
  } catch (err) {
    toast("Refresh failed: " + err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spin");
  }
}

function render() {
  const hash = location.hash || "#/overview";
  const root = $("#view");
  const [path] = hash.split("?");
  const parts = path.replace(/^#\//, "").split("/");
  const tab = parts[0] || "overview";

  for (const a of document.querySelectorAll("#nav a")) {
    a.classList.toggle("active",
      a.dataset.tab === tab || (tab === "session" && a.dataset.tab === "sessions"));
  }

  state.activeKey = tab === "session" ? decodeURIComponent(parts.slice(1).join("/")) : "";
  // Global filters and the KPI strip belong to the dashboard, not to one session.
  $("#filterrow").style.display = tab === "session" ? "none" : "";
  $("#kpis").style.display = tab === "overview" ? "" : "none";

  const done = (p) => p.catch((err) =>
    root.replaceChildren(el("div", { class: "empty", text: "Error: " + err.message })));

  if (tab === "sessions") return done(viewSessions(root));
  if (tab === "search") return done(viewSearch(root));
  if (tab === "session" && parts[1]) return done(viewSession(root, state.activeKey));
  return done(viewOverview(root));
}

function initTheme() {
  const saved = localStorage.getItem("as-theme");
  const preset = document.documentElement.getAttribute("data-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  else if (preset !== "light" && preset !== "dark") {
    // "auto" (or nothing): follow the OS, don't pin a theme.
    document.documentElement.removeAttribute("data-theme");
  }
}

function initKeys() {
  addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open();
      return;
    }
    if (palette.isOpen()) {
      if (e.key === "Escape") { e.preventDefault(); palette.close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); palette.move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palette.move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); palette.choose(); }
      return;
    }
    if (typingInField()) {
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }
    if (meta) return;

    if (e.key === "/") { e.preventDefault(); palette.open(); }
    else if (e.key === "t") toggleTheme();
    else if (e.key === "r") reindex();
    else if (e.key === "1") go("#/overview");
    else if (e.key === "2") go("#/sessions");
    else if (e.key === "3") go("#/search");
  });
}

function init() {
  initTheme();
  initKeys();

  $("#projectFilter").addEventListener("change", (e) => {
    state.project = e.target.value; loadSessions().then(render);
  });
  $("#rangeFilter").addEventListener("change", (e) => {
    state.days = e.target.value; loadSessions().then(render);
  });
  $("#reindex").addEventListener("click", reindex);
  $("#theme").addEventListener("click", toggleTheme);

  $("#searchTrigger").addEventListener("click", () => palette.open());
  $("#paletteInput").addEventListener("input", (e) => palette.build(e.target.value));
  $("#paletteScrim").addEventListener("mousedown", (e) => {
    if (e.target === $("#paletteScrim")) palette.close();
  });

  addEventListener("hashchange", render);

  buildFilters()
    .then(loadSessions)
    .then(render)
    .catch((err) => {
      $("#view").replaceChildren(
        el("div", { class: "empty", text: "Could not load index: " + err.message }));
    });
}

init();

// Exposed for debugging from the browser console (and for screenshot harnesses).
window.AS_APP = { state, palette, render, go, toggleTheme, reindex };
