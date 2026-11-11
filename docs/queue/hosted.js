/* Sai Agents - phone client. Talks to Supabase (auth + Postgres + realtime);
   the Mac runner picks queued tasks up and streams output back. */

const APPS = {
  claude:      { label: "Claude",      letter: "C", color: "#d97757", runs: true,  how: "Runs on your Mac with Claude Code" },
  codex:       { label: "ChatGPT",     letter: "G", color: "#10a37f", runs: true,  how: "Runs on your Mac with the Codex CLI" },
  antigravity: { label: "Antigravity", letter: "A", color: "#4f86f7", runs: false, how: "Opens Antigravity on your Mac with your prompt copied" },
  deepseek:    { label: "DeepSeek",    letter: "D", color: "#6d5dfc", runs: false, how: "Opens DeepSeek Harness on your Mac with your prompt copied" },
};
const STATUS = {
  queued:  { text: "Queued",     v: "--faint" },
  running: { text: "Running",    v: "--run" },
  done:    { text: "Done",       v: "--ok" },
  failed:  { text: "Failed",     v: "--bad" },
  manual:  { text: "Handed off", v: "--manual" },
};
const TABS = { runs: "Runs", sessions: "Sessions", apps: "Limits" };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const now = () => Date.now() / 1000;
const appOf = (id) => APPS[id] || { label: id || "App", letter: "?", color: "#8e8e93", runs: false, how: "" };
const tick = () => { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} };

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

const state = {
  tasks: [], sessions: [], runners: [],
  hasSessions: true, hasRunners: true,
  tab: ls.get("agents.tab", "runs"),
  filter: ls.get("agents.filter", "all"),
  pick: ls.get("agents.pick", "claude"),
  detail: null,            // { kind: "thread" | "session", key }
  full: new Set(),
  openSteps: new Set(),
  user: null,
};
if (!TABS[state.tab]) state.tab = "runs";

let sb = null;

/* ---------------------------------------------------------------- helpers */
function ago(ts) {
  const s = Math.max(0, now() - (ts || 0));
  if (s < 45) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 7) return Math.round(s / 86400) + "d";
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function clock(ts) {
  const d = new Date((ts || 0) * 1000), today = new Date();
  const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? "Today " + t
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " " + t;
}
/* ------------------------------------------------------------- markdown */
function shortUrl(u) {
  try { const x = new URL(u.replace(/&amp;/g, "&")); return x.hostname.replace(/^www\./, "") + (x.pathname.length > 1 ? "/…" : ""); }
  catch (e) { return u; }
}
// `s` is already HTML-escaped.
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>");
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (m, p, u) => p + '<a href="' + u + '" target="_blank" rel="noopener">' + shortUrl(u) + "</a>");
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + codes[Number(i)] + "</code>");
}
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
function md(src) {
  const lines = esc(String(src || "").replace(/\r/g, "")).split("\n");
  const out = [];
  let i = 0;
  const isBlock = (l) => /^```/.test(l) || /^#{1,6}\s/.test(l) || LIST.test(l) || /^&gt;/.test(l) || /^\s*\|.*\|\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
    } else if (!l.trim()) {
      i++;
    } else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      out.push('<div class="mh mh' + Math.min(3, m[1].length) + '">' + inline(m[2].replace(/\s*#+\s*$/, "")) + "</div>"); i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      out.push("<hr>"); i++;
    } else if (/^&gt;/.test(l)) {
      const buf = [];
      while (i < lines.length && /^&gt;/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ""));
      out.push("<blockquote>" + inline(buf.join("<br>")) + "</blockquote>");
    } else if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>");
    } else if (LIST.test(l)) {
      const ordered = /\d/.test(l.match(LIST)[2]);
      const items = [];
      while (i < lines.length) {
        const x = lines[i].match(LIST);
        if (x) { items.push({ sub: x[1].length >= 2, text: x[3] }); i++; }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += " " + lines[i].trim(); i++; }
        else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push("<" + tag + ">" + items.map((it) => "<li" + (it.sub ? ' class="sub"' : "") + ">" + inline(it.text) + "</li>").join("") + "</" + tag + ">");
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlock(lines[i]))) buf.push(lines[i++]);
      out.push("<p>" + inline(buf.join("<br>")) + "</p>");
    }
  }
  return out.join("");
}
const fmt = md;

/* ------------------------------------------------- run output -> answer */
// Codex exec prints a console log (header, prompt echo, tool calls, then the
// answer). Split it into the answer and a list of steps.
const MARK = /^(user|codex|thinking|exec|tokens used)$/;
function toolName(s) {
  const n = s.replace(/\s*\((completed|failed|error)[^)]*\)\s*$/i, "").replace(/\s+started$/, "").trim();
  const parts = n.split("/").pop().split(".");
  return parts.map((p) => p.replace(/_/g, " ")).join(" · ");
}
function parseRun(text) {
  const raw = String(text || "").replace(/\r/g, "");
  if (!/^OpenAI Codex v|^Reading additional input from stdin/m.test(raw)) return { answer: raw.trim(), steps: [], tokens: null };
  let lines = raw.split("\n");
  let dashes = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^-{4,}$/.test(lines[i]) && ++dashes === 2) { lines = lines.slice(i + 1); break; }
  }
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    if (MARK.test(l)) { cur = { kind: l, lines: [] }; blocks.push(cur); continue; }
    if (/^mcp: /.test(l)) { blocks.push({ kind: "mcp", lines: [l.slice(5)] }); cur = null; continue; }
    if (!cur) { cur = { kind: "text", lines: [] }; blocks.push(cur); }
    cur.lines.push(l);
  }
  const steps = [];
  let answer = "", tokens = null, tail = "";
  const notes = [];
  blocks.forEach((b) => {
    const body = b.lines.join("\n").trim();
    if (b.kind === "mcp") {
      const name = toolName(body), done = /\((completed|failed|error)/i.test(body), failed = /failed|error/i.test(body);
      const open = steps.find((s) => s.k === "tool" && s.t === name && !s.done);
      if (open) { open.done = done; open.failed = failed; }
      else steps.push({ k: "tool", t: name, done, failed });
    } else if (b.kind === "exec") {
      steps.push({ k: "cmd", t: (b.lines[0] || "").trim(), done: true, failed: /exited \d+|failed/i.test(body) && !/succeeded/i.test(body) });
    } else if (b.kind === "thinking") {
      if (body) steps.push({ k: "think", t: body.split("\n")[0].replace(/\*\*/g, ""), done: true });
    } else if (b.kind === "tokens used") {
      tokens = (b.lines[0] || "").trim();
      tail = b.lines.slice(1).join("\n").trim();
    } else if ((b.kind === "codex" || b.kind === "text") && body) {
      notes.push(body);
      steps.push({ k: "note", t: body.split("\n")[0], done: true, full: body });
    }
  });
  answer = tail || notes[notes.length - 1] || "";
  const kept = steps.filter((st) => !(st.k === "note" && (st.full === answer || answer.startsWith(st.full))));
  return { answer, steps: kept, tokens };
}

function sessionIdOf(t) {
  const m = String(t.session_ref || "").match(UUID);
  return m ? m[m.length - 1] : null;
}
function stat(st) { return STATUS[st] || STATUS.queued; }
function icon(app, small) {
  const a = appOf(app);
  return '<span class="icon' + (small ? " sm" : "") + '" style="--c:' + a.color + '">' + a.letter + "</span>";
}
function firstLine(text) {
  const l = String(text || "").split("\n").map((x) => x.trim()).find((x) => x && !/^[-=|`]+$/.test(x));
  return l ? l.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*`>]/g, "").replace(/^\s*[-+]\s+/, "").trim() : "";
}
function lastLine(text) {
  const lines = String(text || "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].replace(/[#*`]/g, "") : "";
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}
function autoGrow(el, max) {
  el.style.height = "auto";
  el.style.height = Math.min(max, el.scrollHeight) + "px";
}
function cell(attr, app, title, time, sub, st) {
  const s = st ? stat(st) : null;
  const status = s
    ? '<span class="sdot' + (st === "running" ? " pulse" : "") + '" style="--sc:var(' + s.v + ')"></span>' +
      (st === "done" ? "" : '<span class="stext" style="--sc:var(' + s.v + ')">' + s.text + "</span>" + (sub ? " · " : ""))
    : "";
  return '<button class="cell" ' + attr + ">" + icon(app) +
    '<div class="cellMain"><div class="cellTop"><span class="cellTitle">' + esc(title) + '</span><span class="cellTime">' + time + "</span></div>" +
    '<div class="cellSub">' + status + '<span class="txt">' + esc(sub) + "</span></div></div>" + CHEV + "</button>";
}
function emptyState(svgPath, title, text, action) {
  return '<div class="empty"><svg class="emptyIcon" viewBox="0 0 24 24">' + svgPath + "</svg><b>" + title + "</b>" + text +
    (action ? '<div><button class="btn tinted" data-compose>' + action + "</button></div>" : "") + "</div>";
}

/* ---------------------------------------------------------------- threads */
// A thread is a first task plus every follow-up that resumed its session.
function threads() {
  const alias = {};
  const groups = new Map();
  const asc = state.tasks.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  for (const t of asc) {
    const root = t.resume_id ? (alias[t.resume_id] || t.resume_id) : t.id;
    const sid = sessionIdOf(t);
    if (sid && !alias[sid]) alias[sid] = root;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  return Array.from(groups, ([key, items]) => {
    const last = items[items.length - 1];
    const sess = state.sessions.find((s) => s.session_id === key);
    return {
      key, items, last, app: last.model,
      title: (items[0].action === "open" ? "Open " + appOf(last.model).label : items[0].title) || (sess && sess.title) || "Task",
      at: Math.max(...items.map((t) => t.updated_at || t.created_at || 0)),
    };
  }).sort((a, b) => b.at - a.at);
}
function resumeTarget(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const sid = sessionIdOf(items[i]) || items[i].resume_id;
    if (sid) return sid;
  }
  return null;
}

/* ----------------------------------------------------------------- render */
function renderFilters() {
  const items = [["all", { label: "All" }]].concat(Object.entries(APPS));
  $("#filters").innerHTML = items.map(([id, a]) =>
    '<button class="chip" data-f="' + id + '" aria-pressed="' + (state.filter === id) + '">' +
    (a.color ? '<span class="dot" style="--c:' + a.color + '"></span>' : "") + a.label + "</button>").join("");
  $("#filters").hidden = state.tab === "apps";
}

function renderRuns() {
  const list = threads().filter((th) => state.filter === "all" || th.app === state.filter);
  if (!list.length) {
    $("#view-runs").innerHTML = emptyState('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', "No runs yet",
      "Send a task and watch it run on your Mac.", "New Task");
    return;
  }
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const sections = [["Active", []], ["Today", []], ["Earlier", []]];
  list.forEach((th) => {
    const st = th.last.status;
    const i = st === "running" || st === "queued" ? 0 : th.at * 1000 >= dayStart.getTime() ? 1 : 2;
    sections[i][1].push(th);
  });
  $("#view-runs").innerHTML = sections.filter((s) => s[1].length).map(([name, rows]) =>
    '<div class="sectionHead">' + name + '</div><div class="group">' + rows.map((th) => {
      const t = th.last;
      const sub = firstLine(parseRun(t.output).answer) || t.prompt || (t.status === "queued" ? "Waiting for your Mac" : "");
      return cell('data-thread="' + esc(th.key) + '"', th.app, th.title, ago(th.at), sub, t.status);
    }).join("") + "</div>").join("");
}

function renderSessions() {
  const el = $("#view-sessions");
  if (!state.hasSessions) {
    el.innerHTML = emptyState('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.3A2.5 2.5 0 0 1 4 13.5z"/>',
      "Sessions aren't synced", "Link your Mac to see its sessions here.");
    return;
  }
  const list = state.sessions.filter((s) => state.filter === "all" || s.app === state.filter);
  if (!list.length) {
    el.innerHTML = emptyState('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.3A2.5 2.5 0 0 1 4 13.5z"/>',
      "No sessions", "Recent Claude, ChatGPT and DeepSeek sessions on your Mac show up here.");
    return;
  }
  const order = ["claude", "codex", "deepseek", "antigravity"];
  const by = {};
  list.forEach((s) => { (by[s.app] = by[s.app] || []).push(s); });
  el.innerHTML = order.filter((a) => by[a]).map((a) =>
    '<div class="sectionHead">' + appOf(a).label + '</div><div class="group">' + by[a].map((s) => {
      const p = Array.isArray(s.preview) ? s.preview : [];
      const last = p.length ? p[p.length - 1].t : "";
      return cell('data-session="' + esc(s.id) + '"', s.app, s.title || "Untitled session", ago(s.updated_at),
        lastLine(last) || (s.cwd ? s.cwd.split("/").pop() : ""), null);
    }).join("") + "</div>").join("");
}

/* Limits, mirrored from the Mac widget (runners.limits = ~/.limitswidget/data.json). */
function untilText(iso) {
  if (!iso) return "";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (!(s > 0)) return "resets soon";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return "resets in " + (d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m");
}
function barColor(left) { return left < 20 ? "var(--bad)" : left < 50 ? "var(--run)" : "var(--ok)"; }
function appStatus(p) {
  const s = (p && p.status) || {};
  if (!s.running) return { text: s.sessions > 0 ? s.sessions + " recent" : "Not open", v: "--faint" };
  if (s.state === "working") return { text: "Working", v: "--ok" };
  if (s.state === "waiting") return { text: "Waiting", v: "--run" };
  return { text: "Running", v: "--ok" };
}
function metricHtml(m) {
  const left = Math.max(0, Math.min(100, Number(m.remaining_pct) || 0));
  const value = m.value_text || Math.round(left) + "% left";
  const sub = [m.sublabel, m.detail_text || untilText(m.reset_at)].filter(Boolean).join(" · ");
  const color = m.value_text ? "var(--run)" : barColor(left);
  return '<div class="metric"><div class="mrow"><span>' + esc(m.label) + '</span><b style="color:' +
    (m.value_text ? "var(--label)" : color) + '">' + esc(value) + "</b></div>" +
    '<div class="bar"><i style="width:' + left + "%;background:" + color + '"></i></div>' +
    (sub ? '<div class="msub">' + esc(sub) + "</div>" : "") + "</div>";
}

function renderApps() {
  const runner = macRunner();
  const limits = runner && runner.limits && Array.isArray(runner.limits.providers) ? runner.limits : null;
  const cards = Object.entries(APPS).map(([id, a]) => {
    const p = limits && limits.providers.find((x) => x.id === id);
    const missing = runner && runner.apps && runner.apps[id] === false;
    const st = appStatus(p);
    const s = p && p.status;
    const sub = s && s.running && s.session_name
      ? '<div class="lSub live">' + esc(s.session_name) + "</div>"
      : '<div class="lSub">' + esc((p && (p.vendor || p.name)) || (a.runs ? "Runs on your Mac" : "Hand-off")) + "</div>";
    let body;
    if (missing) body = '<div class="msub">Not installed on your Mac</div>';
    else if (!p) body = '<div class="msub">' + (limits ? "No limits reported" : "Limits appear once your Mac is linked") + "</div>";
    else if (!p.ok && p.error) body = '<div class="msub">' + esc(p.error) + "</div>";
    else body = (p.metrics || []).map(metricHtml).join("") || '<div class="msub">No limits reported</div>';
    return '<div class="limitCard">' +
      '<div class="lHead">' + icon(id) +
      '<div style="min-width:0"><div class="lName">' + a.label +
      (p && p.plan ? '<span class="plan" style="--c:' + a.color + '">' + esc(p.plan) + "</span>" : "") +
      "</div>" + sub + "</div>" +
      (p ? '<span class="badge" style="--sc:var(' + st.v + ')"><i></i>' + st.text + "</span>" : "") +
      "</div>" + body +
      '<div class="lActs"><button class="go" data-new="' + id + '">New Task</button><button data-open="' + id + '">Open on Mac</button></div>' +
      "</div>";
  }).join("");
  const stamp = limits && limits.generated_at
    ? '<div class="sectionFoot" style="text-align:center;margin-top:10px">Updated ' + ago(Date.parse(limits.generated_at) / 1000) + " ago</div>" : "";
  const mac = runner
    ? '<div class="rowLine"><span>Name</span><span class="v">' + esc(runner.name || runner.id) + "</span></div>" +
      '<div class="rowLine"><span>Status</span><span class="v">' + (macOnline() ? "Online" : "Last seen " + ago(runner.seen_at) + " ago") + "</span></div>"
    : '<div class="rowLine"><span>Status</span><span class="v">' + (state.hasRunners ? "Not linked" : "Not synced") + "</span></div>";
  $("#view-apps").innerHTML =
    '<div class="sectionHead">Apps</div>' + cards + stamp +
    '<div class="sectionHead">Mac</div><div class="group">' + mac + "</div>" +
    '<div class="sectionHead">Account</div><div class="group">' +
    '<div class="rowLine"><span>Email</span><span class="v">' + esc(state.user && state.user.email) + "</span></div></div>" +
    '<div class="group" style="margin-top:20px"><button class="rowLine danger" id="signOut">Sign Out</button></div>';
}

function macRunner() {
  return state.runners.slice().sort((a, b) => (b.seen_at || 0) - (a.seen_at || 0))[0] || null;
}
function macOnline() {
  const r = macRunner();
  return !!(r && now() - (r.seen_at || 0) < 45);
}
function renderMac() {
  const line = $("#macLine");
  const r = macRunner();
  const active = state.tasks.filter((t) => t.status === "running" || t.status === "queued").length;
  line.dataset.state = !r ? "unknown" : macOnline() ? "online" : "offline";
  const base = !r ? (state.hasRunners ? "Mac not linked" : "Mac status unavailable")
    : (r.name || "Mac") + (macOnline() ? " · Online" : " · Offline");
  line.querySelector("span").textContent = base + (active ? " · " + active + " active" : "");
}

function render() {
  renderFilters();
  renderMac();
  $("#pageTitle").textContent = TABS[state.tab];
  $("#navTitle").textContent = TABS[state.tab];
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  ["runs", "sessions", "apps"].forEach((v) => { $("#view-" + v).hidden = v !== state.tab; });
  if (state.tab === "runs") renderRuns();
  if (state.tab === "sessions") renderSessions();
  if (state.tab === "apps") renderApps();
  if (state.detail) renderDetail();
}

/* ----------------------------------------------------------------- detail */
function stepHtml(st) {
  const ic = st.k === "tool" ? "⚙︎" : st.k === "cmd" ? "›_" : st.k === "think" ? "✦" : "•";
  const tail = st.failed ? '<span class="sbad">failed</span>' : st.done ? "" : '<span class="spin"></span>';
  return '<li><span class="sic">' + ic + '</span><span class="stx">' + esc(st.t) + "</span>" + tail + "</li>";
}
function taskBubbles(t) {
  const a = appOf(t.model);
  if (t.action === "open") {
    return '<div class="note">Asked your Mac to open ' + esc(a.label) + " · " + stat(t.status).text.toLowerCase() + "</div>";
  }
  const run = parseRun(t.output);
  const live = t.status === "queued" || t.status === "running";
  const s = stat(t.status);
  let answer = run.answer;
  const LIMIT = 12000;
  const cut = !state.full.has(t.id) && answer.length > LIMIT;
  if (cut) answer = answer.slice(0, LIMIT) + "…";

  let steps = "";
  if (run.steps.length) {
    const open = state.openSteps.has(t.id);
    const last = run.steps[run.steps.length - 1];
    const label = live && !run.answer ? esc(last.t) + "…"
      : run.steps.length + (run.steps.length === 1 ? " step" : " steps") + (run.tokens ? " · " + esc(run.tokens) + " tokens" : "");
    steps = '<button class="stepsBtn' + (open ? " open" : "") + '" data-steps="' + t.id + '">' +
      (live && !run.answer ? '<span class="spin"></span>' : '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>') +
      "<span>" + label + "</span></button>" +
      (open ? '<ul class="steps">' + run.steps.map(stepHtml).join("") + "</ul>" : "");
  }
  let body;
  if (answer) body = '<div class="msg bot md">' + md(answer) +
    (cut ? '<button class="more" data-full="' + t.id + '">Show all</button>' : "") + "</div>";
  else if (live) body = '<div class="msg bot"><span class="typing"><i></i><i></i><i></i></span></div>';
  else body = '<div class="msg bot"><span style="opacity:.6">No output</span></div>';

  return '<div class="stamp"><b>' + clock(t.created_at) + "</b></div>" +
    '<div class="msg user">' + esc(t.prompt) + "</div>" +
    '<div class="botMeta">' + icon(t.model, true) + "<span>" + a.label + '</span><span class="stext" style="--sc:var(' + s.v + ')">' + s.text + "</span></div>" +
    steps + body;
}

function currentThread() {
  if (!state.detail) return null;
  return threads().find((th) => th.key === state.detail.key) || null;
}
function currentSession() {
  return state.detail ? state.sessions.find((s) => s.id === state.detail.key) : null;
}

function renderDetail() {
  const d = state.detail;
  const box = $("#thread");
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let html = "", title = "", sub = "", app = null, canResume = false;

  if (d.kind === "thread") {
    const th = currentThread();
    if (!th) { html = '<div class="empty">This run was deleted.</div>'; }
    else {
      app = th.app; title = th.title;
      sub = appOf(app).label + " · " + stat(th.last.status).text;
      const sess = state.sessions.find((s) => s.session_id === th.key);
      if (sess && th.items[0].resume_id) html += previewHtml(sess);
      html += th.items.map(taskBubbles).join("");
      canResume = appOf(app).runs && !!resumeTarget(th.items);
    }
  } else {
    const s = currentSession();
    if (!s) { html = '<div class="empty">Session not found.</div>'; }
    else {
      app = s.app; title = s.title || "Session";
      sub = appOf(app).label + (s.cwd ? " · " + s.cwd.split("/").pop() : "");
      html += previewHtml(s);
      const th = threads().find((x) => x.key === s.session_id);
      if (th) html += th.items.map(taskBubbles).join("");
      canResume = appOf(app).runs && s.can_resume;
    }
  }
  $("#detailTitle").textContent = title;
  $("#detailSub").textContent = sub;
  $("#backLabel").textContent = TABS[state.tab];
  box.innerHTML = html;
  const a = appOf(app);
  $("#replyText").placeholder = canResume ? "Message " + a.label
    : a.runs ? "New " + a.label + " task" : "Hand off to " + a.label;
  if (stick || d.justOpened) { box.scrollTop = box.scrollHeight; d.justOpened = false; }
}

function previewHtml(s) {
  const p = Array.isArray(s.preview) ? s.preview : [];
  if (!p.length) return "";
  return '<div class="stamp">On your Mac · <b>' + clock(s.updated_at) + "</b></div>" + p.map((m) =>
    m.r === "user"
      ? '<div class="msg user">' + esc(m.t) + "</div>"
      : '<div class="msg bot">' + fmt(m.t) + "</div>").join("");
}

function openDetail(kind, key) {
  const push = !state.detail;
  state.detail = { kind, key, justOpened: true };
  const el = $("#detail");
  el.classList.remove("out"); el.style.transform = ""; el.style.transition = "";
  el.hidden = false;
  if (push) {
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    history.pushState({ detail: true }, "");
  }
  renderDetail();
}
function closeDetail(fromPop) {
  if (!state.detail) return;
  // Go through history so the phone's back gesture and our back button agree;
  // the popstate handler below does the actual closing.
  if (!fromPop && history.state && history.state.detail) { history.back(); return; }
  state.detail = null;
  closeMenu();
  const el = $("#detail");
  el.style.transition = "";
  el.classList.add("out");
  setTimeout(() => { if (!state.detail) { el.hidden = true; el.classList.remove("out"); el.style.transform = ""; } }, 300);
  render();
}
window.addEventListener("popstate", () => closeDetail(true));

/* ------------------------------------------------------------------- data */
async function load() {
  if (!sb || !state.user) return;
  const [t, s, r] = await Promise.all([
    sb.from("tasks").select("*").order("created_at", { ascending: false }).limit(150),
    sb.from("sessions").select("*").order("updated_at", { ascending: false }).limit(60),
    sb.from("runners").select("*"),
  ]);
  if (!t.error) state.tasks = t.data || [];
  else toast("Couldn't load runs: " + t.error.message);
  state.hasSessions = !s.error;
  state.sessions = s.error ? [] : s.data || [];
  state.hasRunners = !r.error;
  state.runners = r.error ? [] : r.data || [];
  render();
}
let loadTimer = null;
function soon() { clearTimeout(loadTimer); loadTimer = setTimeout(load, 250); }

async function queueTask(model, prompt, resumeId) {
  const t = now();
  const row = {
    id: "t_" + crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 12),
    title: prompt.split("\n")[0].slice(0, 90), prompt, model,
    status: "queued", output: "", action: "run", created_at: t, updated_at: t,
    owner: state.user.id,
  };
  if (resumeId) row.resume_id = resumeId;
  const { error } = await sb.from("tasks").insert(row);
  if (error) throw error;
  state.tasks.unshift(row);
  return row;
}
async function openOnMac(model) {
  const t = now();
  const { error } = await sb.from("tasks").insert({
    id: "t_" + crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 12),
    title: "Open " + appOf(model).label, prompt: "", model, status: "queued", output: "",
    action: "open", created_at: t, updated_at: t, owner: state.user.id,
  });
  if (error) return toast(error.message);
  tick();
  toast(macOnline() ? "Opening " + appOf(model).label + " on your Mac" : "Opens when your Mac is back online");
  soon();
}

/* ------------------------------------------------------------------- auth */
function config() {
  const c = window.QUEUE_CONFIG;
  if (c && c.url && c.anonKey && c.url.indexOf("__") !== 0) return c;
  return ls.get("agents.cfg", null);
}

async function boot() {
  const cfg = config();
  if (!cfg) { showAuth(true); return; }
  sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "agents.auth" },
  });
  sb.auth.onAuthStateChange((event, session) => {
    const was = state.user;
    state.user = session ? session.user : null;
    if (state.user && !was) startApp();
    if (!state.user && was) showAuth(false);
  });
  const { data } = await sb.auth.getSession();
  state.user = data.session ? data.session.user : null;
  if (state.user) startApp(); else showAuth(false);
}

function showAuth(needCfg) {
  $("#app").hidden = true; $("#detail").hidden = true;
  $("#auth").hidden = false;
  $("#setupForm").hidden = !needCfg;
  $("#signInForm").hidden = needCfg;
}

let started = false;
function startApp() {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  render();
  load();
  if (started) return;
  started = true;
  sb.channel("agents")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, soon)
    .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, soon)
    .on("postgres_changes", { event: "*", schema: "public", table: "runners" }, soon)
    .subscribe();
  // Realtime does the heavy lifting; this is the safety net.
  setInterval(() => {
    if (document.hidden) return;
    const busy = state.tasks.some((t) => t.status === "running" || t.status === "queued");
    if (busy || Math.random() < 0.35) load(); else renderMac();
  }, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}

const msg = (t) => { $("#authMsg").textContent = t; };
$("#setupForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#cfgUrl").value.trim().replace(/\/$/, ""), anonKey = $("#cfgKey").value.trim();
  if (!url || !anonKey) return;
  ls.set("agents.cfg", { url, anonKey });
  boot();
});
$("#signInForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  msg("Signing in…");
  const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
  msg(error ? error.message : "");
});
$("#magicLink").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  if (!email) return msg("Enter your email first.");
  msg("Sending…");
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
  msg(error ? error.message : "Check your inbox for the sign-in link.");
});

/* ------------------------------------------------------------ navigation */
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.filter = b.dataset.f; ls.set("agents.filter", state.filter);
  tick(); render();
});
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  if (state.tab === b.dataset.tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  state.tab = b.dataset.tab; ls.set("agents.tab", state.tab);
  tick(); render(); window.scrollTo(0, 0); onScroll();
}));
$("#macLine").addEventListener("click", () => { state.tab = "apps"; ls.set("agents.tab", "apps"); render(); window.scrollTo(0, 0); });

// Large title collapses into the bar, like a native navigation bar.
function onScroll() { $("#nav").classList.toggle("scrolled", window.scrollY > 38); }
window.addEventListener("scroll", onScroll, { passive: true });

$("#views").addEventListener("click", async (e) => {
  const th = e.target.closest("[data-thread]");
  if (th) return openDetail("thread", th.dataset.thread);
  const se = e.target.closest("[data-session]");
  if (se) return openDetail("session", se.dataset.session);
  const nw = e.target.closest("[data-new]");
  if (nw) return openSheet(nw.dataset.new);
  if (e.target.closest("[data-compose]")) return openSheet(state.filter !== "all" ? state.filter : null);
  const op = e.target.closest("[data-open]");
  if (op) return openOnMac(op.dataset.open);
  if (e.target.closest("#signOut")) {
    actionSheet("Sign out of Sai Agents?", [["Sign Out", async () => { await sb.auth.signOut(); location.reload(); }, "danger"]]);
  }
});

/* ------------------------------------------------------------ new task */
function renderPicker() {
  $("#appPicker").innerHTML = Object.entries(APPS).map(([id, a]) =>
    '<button type="button" class="pick" role="radio" data-pick="' + id + '" aria-checked="' + (state.pick === id) + '">' +
    icon(id) + a.label + "</button>").join("");
  $("#pickerNote").textContent = appOf(state.pick).how + (macOnline() ? "" : " · your Mac looks offline, it runs when it's back");
}
function openSheet(app) {
  if (app) { state.pick = app; ls.set("agents.pick", app); }
  renderPicker();
  $("#sheetSend").disabled = !$("#prompt").value.trim();
  const sh = $("#sheet");
  sh.classList.remove("closing"); sh.style.transform = "";
  sh.hidden = false; $("#sheetBackdrop").hidden = false; $("#sheetBackdrop").classList.remove("closing");
  setTimeout(() => $("#prompt").focus(), 350);
}
function closeSheet() {
  const sh = $("#sheet"), bd = $("#sheetBackdrop");
  if (sh.hidden) return;
  $("#prompt").blur();
  sh.style.transform = ""; sh.classList.add("closing"); bd.classList.add("closing");
  setTimeout(() => { sh.hidden = true; bd.hidden = true; sh.classList.remove("closing"); bd.classList.remove("closing"); }, 280);
}
$("#compose").addEventListener("click", () => openSheet(state.filter !== "all" ? state.filter : null));
$("#sheetClose").addEventListener("click", closeSheet);
$("#sheetBackdrop").addEventListener("click", closeSheet);
$("#appPicker").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b) return;
  state.pick = b.dataset.pick; ls.set("agents.pick", state.pick);
  tick(); renderPicker();
});
$("#prompt").addEventListener("input", () => { $("#sheetSend").disabled = !$("#prompt").value.trim(); });
$("#sheet").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#prompt").value.trim();
  if (!text) return $("#prompt").focus();
  $("#sheetSend").disabled = true;
  try {
    const row = await queueTask(state.pick, text);
    tick();
    $("#prompt").value = "";
    closeSheet();
    state.tab = "runs"; ls.set("agents.tab", "runs");
    render();
    openDetail("thread", row.id);
    soon();
  } catch (err) { toast("Couldn't send: " + err.message); $("#sheetSend").disabled = false; }
});
$("#prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#sheet").requestSubmit(); }
});

/* ------------------------------------------------------- detail: reply */
$("#back").addEventListener("click", () => closeDetail(false));
const replyText = $("#replyText");
const syncSend = () => { $("#replySend").disabled = !replyText.value.trim(); };
replyText.addEventListener("input", () => { autoGrow(replyText, 140); syncSend(); });
replyText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer:fine)").matches) {
    e.preventDefault(); $("#reply").requestSubmit();
  }
});
syncSend();
$("#reply").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = replyText.value.trim();
  if (!text || !state.detail) return;
  let app, resume = null;
  if (state.detail.kind === "thread") {
    const th = currentThread(); if (!th) return;
    app = th.app;
    if (appOf(app).runs) resume = resumeTarget(th.items);
  } else {
    const s = currentSession(); if (!s) return;
    app = s.app;
    if (appOf(app).runs && s.can_resume) resume = s.session_id;
  }
  $("#replySend").disabled = true;
  try {
    const row = await queueTask(app, text, resume);
    tick();
    replyText.value = ""; autoGrow(replyText, 140);
    if (!resume && state.detail.kind === "thread") state.detail.key = row.id;
    state.detail.justOpened = true;
    renderDetail();
    soon();
  } catch (err) {
    toast("Couldn't send: " + err.message);
  } finally { syncSend(); }
});
$("#thread").addEventListener("click", (e) => {
  const f = e.target.closest("[data-full]");
  if (f) { state.full.add(f.dataset.full); renderDetail(); return; }
  const st = e.target.closest("[data-steps]");
  if (st) {
    const id = st.dataset.steps;
    if (state.openSteps.has(id)) state.openSteps.delete(id); else state.openSteps.add(id);
    tick(); renderDetail();
  }
});

/* ---------------------------------------------------------- action sheet */
function actionSheet(title, items) {
  const m = $("#menu");
  m.innerHTML = '<div class="asGroup">' + (title ? '<div class="asTitle">' + esc(title) + "</div>" : "") +
    items.map((it, i) => '<button data-i="' + i + '" class="' + (it[2] || "") + '">' + esc(it[0]) + "</button>").join("") +
    '</div><button class="asCancel" data-cancel>Cancel</button>';
  m._items = items;
  m.classList.remove("closing"); $("#menuBackdrop").classList.remove("closing");
  m.hidden = false; $("#menuBackdrop").hidden = false;
}
function closeMenu() {
  const m = $("#menu"), bd = $("#menuBackdrop");
  if (m.hidden) return;
  m.classList.add("closing"); bd.classList.add("closing");
  setTimeout(() => { m.hidden = true; bd.hidden = true; m.classList.remove("closing"); bd.classList.remove("closing"); }, 240);
}
$("#menuBackdrop").addEventListener("click", closeMenu);
$("#menu").addEventListener("click", (e) => {
  if (e.target.closest("[data-cancel]")) return closeMenu();
  const b = e.target.closest("[data-i]");
  if (!b) return;
  const fn = $("#menu")._items[Number(b.dataset.i)][1];
  closeMenu();
  fn();
});

function menuItems() {
  const d = state.detail;
  if (!d) return [];
  if (d.kind === "thread") {
    const th = currentThread(); if (!th) return [];
    const t = th.last, a = appOf(th.app);
    const items = [["Open " + a.label + " on Mac", () => openOnMac(th.app)]];
    const withOut = th.items.filter((x) => x.output && x.action !== "open").pop();
    if (withOut) items.push(["Copy Output", async () => { await navigator.clipboard.writeText(withOut.output); toast("Copied"); }]);
    if (t.action !== "open" && (t.status === "failed" || t.status === "done" || t.status === "manual")) {
      items.push(["Run Again", async () => {
        const { error } = await sb.from("tasks").update({ status: "queued", output: "", exit_code: null, updated_at: now() }).eq("id", t.id);
        if (error) toast(error.message); else { tick(); toast("Queued again"); soon(); }
      }]);
    }
    items.push(["Delete Run", () => {
      actionSheet("This removes the run from your history. The session on your Mac is not touched.", [["Delete Run", async () => {
        const { error } = await sb.from("tasks").delete().in("id", th.items.map((x) => x.id));
        if (error) return toast(error.message);
        state.tasks = state.tasks.filter((x) => !th.items.includes(x));
        closeDetail(false);
      }, "danger"]]);
    }, "danger"]);
    return items;
  }
  const s = currentSession(); if (!s) return [];
  return [
    ["Open " + appOf(s.app).label + " on Mac", () => openOnMac(s.app)],
    ["Copy Session ID", async () => { await navigator.clipboard.writeText(s.session_id); toast("Copied"); }],
  ];
}
$("#more").addEventListener("click", () => {
  const items = menuItems();
  if (items.length) actionSheet(null, items);
});

/* -------------------------------------------------------------- gestures */
// Swipe from the left edge to go back.
(function swipeBack() {
  const el = $("#detail");
  let g = null;
  el.addEventListener("touchstart", (e) => {
    const p = e.touches[0];
    if (p.clientX > 30) return;
    g = { x: p.clientX, y: p.clientY, t: Date.now(), dx: 0, locked: false };
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (!g) return;
    const p = e.touches[0];
    const dx = p.clientX - g.x, dy = p.clientY - g.y;
    if (!g.locked) {
      if (Math.abs(dy) > Math.abs(dx)) { g = null; return; }
      g.locked = true; el.style.transition = "none";
    }
    g.dx = Math.max(0, dx);
    el.style.transform = "translateX(" + g.dx + "px)";
  }, { passive: true });
  el.addEventListener("touchend", () => {
    if (!g) return;
    const v = g.dx / Math.max(1, Date.now() - g.t);
    const go = g.dx > innerWidth * 0.35 || (v > 0.5 && g.dx > 40);
    el.style.transition = "";
    el.style.transform = go ? "translateX(100%)" : "";
    g = null;
    if (go) setTimeout(() => closeDetail(false), 10);
  });
})();

// Drag the sheet's handle down to dismiss it.
(function sheetDrag() {
  const sh = $("#sheet"), handle = $("#sheetDrag");
  let g = null;
  handle.addEventListener("touchstart", (e) => {
    if (e.target.closest("button")) return;
    g = { y: e.touches[0].clientY, dy: 0 }; sh.style.transition = "none";
  }, { passive: true });
  handle.addEventListener("touchmove", (e) => {
    if (!g) return;
    g.dy = Math.max(0, e.touches[0].clientY - g.y);
    sh.style.transform = "translateY(" + g.dy + "px)";
  }, { passive: true });
  handle.addEventListener("touchend", () => {
    if (!g) return;
    sh.style.transition = "";
    if (g.dy > 120) closeSheet(); else sh.style.transform = "";
    g = null;
  });
})();

// Pull down at the top of a list to refresh.
(function pullToRefresh() {
  const ptr = $("#ptr");
  let g = null;
  const busy = () => state.detail || !$("#sheet").hidden || !$("#menu").hidden || $("#app").hidden;
  document.addEventListener("touchstart", (e) => {
    if (busy() || window.scrollY > 0) { g = null; return; }
    g = { y: e.touches[0].clientY, d: 0 };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!g) return;
    g.d = Math.max(0, (e.touches[0].clientY - g.y) * 0.5);
    ptr.style.transition = "none";
    ptr.style.height = Math.min(g.d, 80) + "px";
    ptr.classList.toggle("ready", g.d >= 60);
  }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (!g) return;
    const ready = g.d >= 60;
    g = null;
    ptr.style.transition = "";
    if (ready) {
      tick();
      ptr.style.height = "52px"; ptr.classList.add("loading");
      await load().catch(() => {});
    }
    ptr.classList.remove("loading", "ready");
    ptr.style.height = "0px";
  });
})();

/* ------------------------------------------------- install hint (iOS) */
// iOS only offers "Add to Home Screen" from Safari's (or Chrome/Edge's) Share
// menu - never inside another app's built-in browser - so say exactly what to do.
function installHint(ua) {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  if (!ios || standalone || ls.get("agents.installDismissed", false) || $(".install")) return;

  const share = '<svg class="shareGlyph" viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>';
  const inApp = /FBAN|FBAV|Instagram|Line\/|GSA\/|Snapchat|Twitter|LinkedInApp|Slack|Gmail|Outlook|Teams|Claude|wv\)/i.test(ua)
    || (!/Safari\//.test(ua) && !/CriOS|EdgiOS|FxiOS/.test(ua));
  const thirdParty = /CriOS|EdgiOS|FxiOS/.test(ua);
  let html;
  if (inApp) {
    html = "<b>Open in Safari to install</b><ol>" +
      "<li>This app's built-in browser can't add to your Home Screen.</li>" +
      "<li>Tap <strong>Copy Link</strong>, open <strong>Safari</strong>, paste and go.</li></ol>" +
      '<button class="btn tinted" data-copy>Copy Link</button>';
  } else if (thirdParty) {
    html = "<b>Install on your iPhone</b><ol>" +
      "<li>Tap " + share + " <strong>Share</strong> in the address bar.</li>" +
      "<li>Choose <strong>Add to Home Screen</strong>. Not listed? Open this page in Safari.</li></ol>";
  } else {
    html = "<b>Install on your iPhone</b><ol>" +
      "<li>Tap " + share + " <strong>Share</strong> (or <strong>•••</strong> then Share) in Safari.</li>" +
      "<li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li></ol>";
  }
  const box = document.createElement("div");
  box.className = "install";
  box.innerHTML = '<button class="x" aria-label="Dismiss">✕</button>' + html;
  document.body.appendChild(box);
  box.addEventListener("click", async (e) => {
    if (e.target.closest(".x")) { ls.set("agents.installDismissed", true); box.remove(); return; }
    if (e.target.closest("[data-copy]")) {
      try { await navigator.clipboard.writeText(location.origin + location.pathname); toast("Link copied - paste it in Safari"); }
      catch (err) { prompt("Copy this link and open it in Safari:", location.origin + location.pathname); }
    }
  });
}
installHint(navigator.userAgent);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
