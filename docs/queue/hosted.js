/* Sai Agents - phone client. Talks to Supabase (auth + Postgres + realtime);
   the Mac runner picks queued tasks up and streams output back. */

const APPS = {
  claude:      { label: "Claude",      letter: "C", color: "#d97757", runs: true,  how: "Runs headlessly with Claude Code" },
  codex:       { label: "ChatGPT",     letter: "G", color: "#10a37f", runs: true,  how: "Runs headlessly with the Codex CLI" },
  antigravity: { label: "Antigravity", letter: "A", color: "#4f86f7", runs: false, how: "Opens the app on your Mac with your prompt on the clipboard" },
  deepseek:    { label: "DeepSeek",    letter: "D", color: "#6d5dfc", runs: false, how: "Opens DeepSeek Harness with your prompt on the clipboard" },
};
const STATUS = {
  queued:  { text: "Queued",  v: "--faint" },
  running: { text: "Running", v: "--run" },
  done:    { text: "Done",    v: "--ok" },
  failed:  { text: "Failed",  v: "--bad" },
  manual:  { text: "Handed off", v: "--manual" },
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const now = () => Date.now() / 1000;
const appOf = (id) => APPS[id] || { label: id || "App", letter: "?", color: "#888", runs: false, how: "" };

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
  user: null,
};

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
function fmt(text) {
  let s = esc(String(text || "").replace(/\r/g, ""));
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (m, code) => "<pre>" + code.replace(/\n$/, "") + "</pre>");
  s = s.replace(/^#{1,6}\s+(.*)$/gm, "<span class='h'>$1</span>");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return s;
}
function sessionIdOf(t) {
  const m = String(t.session_ref || "").match(UUID);
  return m ? m[m.length - 1] : null;
}
function statusHtml(st) {
  const s = STATUS[st] || STATUS.queued;
  return '<span class="status" data-s="' + st + '" style="--sc:var(' + s.v + ')"><i></i>' + s.text + "</span>";
}
function glyph(app, small) {
  const a = appOf(app);
  return '<span class="glyph' + (small ? " sm" : "") + '" style="--c:' + a.color + '">' + a.letter + "</span>";
}
function lastLine(text) {
  const lines = String(text || "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].replace(/[#*`]/g, "") : "";
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}
function autoGrow(el, max) {
  el.style.height = "auto";
  el.style.height = Math.min(max, el.scrollHeight) + "px";
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
    t._root = root;
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
    '<button class="pill" data-f="' + id + '" aria-pressed="' + (state.filter === id) + '">' +
    (a.color ? '<span class="dot" style="--c:' + a.color + '"></span>' : "") + a.label + "</button>").join("");
  $("#filters").hidden = state.tab === "apps";
}

function renderRuns() {
  const list = threads().filter((th) => state.filter === "all" || th.app === state.filter);
  if (!list.length) {
    $("#view-runs").innerHTML = '<div class="empty"><b>No runs yet</b>Tap + to send a task to your Mac.</div>';
    return;
  }
  $("#view-runs").innerHTML = '<div class="list">' + list.map((th) => {
    const t = th.last;
    const sub = t.status === "running" || t.status === "queued"
      ? (lastLine(t.output) || t.prompt || "Waiting for the Mac…")
      : (lastLine(t.output) || t.prompt || "");
    const n = th.items.length > 1 ? " · " + th.items.length + " turns" : "";
    return '<button class="row" data-thread="' + esc(th.key) + '">' + glyph(th.app) +
      '<div class="body"><div class="t">' + esc(th.title) + '</div><div class="s">' + esc(sub) + "</div></div>" +
      '<div class="side"><span class="when">' + ago(th.at) + n + "</span>" + statusHtml(t.status) + "</div></button>";
  }).join("") + "</div>";
}

function renderSessions() {
  const el = $("#view-sessions");
  if (!state.hasSessions) {
    el.innerHTML = '<div class="empty"><b>Sessions aren\'t synced yet</b>Run <code>queue/connect-supabase.sh</code> on your Mac once to turn this on.</div>';
    return;
  }
  const list = state.sessions.filter((s) => state.filter === "all" || s.app === state.filter);
  if (!list.length) {
    el.innerHTML = '<div class="empty"><b>No sessions</b>Recent Claude, ChatGPT and DeepSeek sessions on your Mac show up here.</div>';
    return;
  }
  const order = ["claude", "codex", "deepseek", "antigravity"];
  const by = {};
  list.forEach((s) => { (by[s.app] = by[s.app] || []).push(s); });
  el.innerHTML = order.filter((a) => by[a]).map((a) =>
    '<div class="group">' + appOf(a).label + "</div>" +
    '<div class="list">' + by[a].map((s) => {
      const p = Array.isArray(s.preview) ? s.preview : [];
      const last = p.length ? p[p.length - 1].t : "";
      return '<button class="row" data-session="' + esc(s.id) + '">' + glyph(s.app) +
        '<div class="body"><div class="t">' + esc(s.title || "Untitled session") + '</div><div class="s">' + esc(lastLine(last) || (s.cwd || "")) + "</div></div>" +
        '<div class="side"><span class="when">' + ago(s.updated_at) + "</span></div></button>";
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
function barColor(left) {
  return left < 20 ? "var(--bad)" : left < 50 ? "var(--run)" : "var(--ok)";
}
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
    (m.value_text ? "var(--text)" : color) + '">' + esc(value) + "</b></div>" +
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
      ? '<div class="live">▸ ' + esc(s.session_name) + "</div>"
      : '<div class="mode">' + esc((p && (p.vendor || p.name)) || (a.runs ? "Headless" : "Hand-off")) + "</div>";
    let body;
    if (missing) body = '<div class="msub">Not installed on your Mac</div>';
    else if (!p) body = '<div class="msub">' + (limits ? "No limits reported" : "Limits appear once your Mac is linked") + "</div>";
    else if (!p.ok && p.error) body = '<div class="msub">' + esc(p.error) + "</div>";
    else body = (p.metrics || []).map(metricHtml).join("") || '<div class="msub">No limits reported</div>';
    return '<div class="appCard">' +
      '<div class="ahead">' + glyph(id) +
      '<div class="aname"><div class="name">' + a.label +
      (p && p.plan ? ' <span class="plan" style="--c:' + a.color + '">' + esc(p.plan) + "</span>" : "") +
      "</div>" + sub + "</div>" +
      (p ? '<span class="status" style="--sc:var(' + st.v + ')"><i></i>' + st.text + "</span>" : "") +
      "</div>" + body +
      '<div class="acts"><button class="btn go" data-new="' + id + '">New task</button><button class="btn" data-open="' + id + '">Open on Mac</button></div>' +
      "</div>";
  }).join("");
  const stamp = limits && limits.generated_at
    ? '<div class="fine" style="text-align:center">Limits updated ' + ago(Date.parse(limits.generated_at) / 1000) + " ago</div>" : "";
  const mac = runner
    ? '<div class="kv"><span>Mac</span><span>' + esc(runner.name || runner.id) + "</span></div>" +
      '<div class="kv"><span>Last seen</span><span>' + (macOnline() ? "online" : ago(runner.seen_at) + " ago") + "</span></div>"
    : '<div class="kv"><span>Mac</span><span>' + (state.hasRunners ? "not connected" : "status not synced") + "</span></div>";
  $("#view-apps").innerHTML =
    '<div class="appGrid">' + cards + "</div>" + stamp +
    '<div class="group">Mac</div><div class="card">' + mac + "</div>" +
    '<div class="group">Account</div><div class="card">' +
    '<div class="kv"><span>Signed in as</span><span>' + esc(state.user && state.user.email) + "</span></div>" +
    '<div style="margin-top:10px"><button class="btn small" id="signOut">Sign out</button></div></div>';
}

function macRunner() {
  return state.runners.slice().sort((a, b) => (b.seen_at || 0) - (a.seen_at || 0))[0] || null;
}
function macOnline() {
  const r = macRunner();
  return !!(r && now() - (r.seen_at || 0) < 45);
}
function renderMac() {
  const pill = $("#macPill");
  const r = macRunner();
  pill.dataset.state = !r ? "unknown" : macOnline() ? "online" : "offline";
  pill.querySelector("span").textContent = !r ? "Mac" : macOnline() ? "Mac online" : "Mac offline";
}

function render() {
  renderFilters();
  renderMac();
  $("#pageTitle").textContent = { runs: "Runs", sessions: "Sessions", apps: "Limits" }[state.tab];
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  ["runs", "sessions", "apps"].forEach((v) => { $("#view-" + v).hidden = v !== state.tab; });
  if (state.tab === "runs") renderRuns();
  if (state.tab === "sessions") renderSessions();
  if (state.tab === "apps") renderApps();
  if (state.detail) renderDetail();
}

/* ----------------------------------------------------------------- detail */
function taskBubbles(t) {
  const a = appOf(t.model);
  if (t.action === "open") {
    return '<div class="note">Asked the Mac to open ' + esc(a.label) + " · " + (STATUS[t.status] || STATUS.queued).text.toLowerCase() + "</div>";
  }
  let out = t.output || "";
  const LIMIT = 8000;
  const cut = !state.full.has(t.id) && out.length > LIMIT;
  if (cut) out = "…" + out.slice(-LIMIT);
  const waiting = (t.status === "queued" || t.status === "running") && !t.output;
  const body = waiting ? '<span class="typing"><i></i><i></i><i></i></span>' : fmt(out) || '<span class="muted">No output</span>';
  return '<div class="msg user">' + esc(t.prompt) + "</div>" +
    '<div class="msg bot"><div class="meta">' + glyph(t.model, true) + "<span>" + a.label + " · " + ago(t.updated_at || t.created_at) + "</span>" + statusHtml(t.status) + "</div>" +
    '<div class="bubble">' + body +
    (cut ? '<div><button class="more" data-full="' + t.id + '">Show full output (' + (t.output.length / 1000).toFixed(1) + "k chars)</button></div>" : "") +
    "</div></div>";
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
      sub = appOf(app).label + " · " + (STATUS[th.last.status] || STATUS.queued).text;
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
  box.innerHTML = html;
  const a = appOf(app);
  $("#replyText").placeholder = canResume ? "Continue in this " + a.label + " session…"
    : a.runs ? "Send a new " + a.label + " task…" : "Hand off to " + a.label + " on your Mac…";
  if (stick || d.justOpened) { box.scrollTop = box.scrollHeight; d.justOpened = false; }
}

function previewHtml(s) {
  const p = Array.isArray(s.preview) ? s.preview : [];
  if (!p.length) return "";
  return '<div class="note">Latest from this session on your Mac</div>' + p.map((m) =>
    m.r === "user"
      ? '<div class="msg user">' + esc(m.t) + "</div>"
      : '<div class="msg bot"><div class="bubble">' + fmt(m.t) + "</div></div>").join("") +
    '<div class="note">' + ago(s.updated_at) + " ago</div>";
}

function openDetail(kind, key) {
  const push = !state.detail;
  state.detail = { kind, key, justOpened: true };
  $("#detail").hidden = false;
  document.body.style.overflow = "hidden";
  if (push) history.pushState({ detail: true }, "");
  renderDetail();
}
function closeDetail(fromPop) {
  if (!state.detail) return;
  // Go through history so the phone's back gesture and our back button agree;
  // the popstate handler below does the actual closing.
  if (!fromPop && history.state && history.state.detail) { history.back(); return; }
  state.detail = null;
  $("#detail").hidden = true;
  $("#menu").hidden = true;
  document.body.style.overflow = "";
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
  toast(macOnline() ? "Opening " + appOf(model).label + " on your Mac" : "Queued: opens when your Mac is online");
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

let started = false, poll = null;
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
    .on("postgres_changes", { event: "*", schema: "public", table: "runners" }, () => { soon(); })
    .subscribe();
  // Realtime does the heavy lifting; this is the safety net.
  poll = setInterval(() => {
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
$("#signUp").addEventListener("click", async () => {
  const email = $("#email").value.trim(), password = $("#password").value;
  if (!email || !password) return msg("Enter an email and a password first.");
  msg("Creating account…");
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) return msg(error.message);
  msg(data.session ? "" : "Check your email to confirm, then sign in.");
});
$("#magicLink").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  if (!email) return msg("Enter your email first.");
  msg("Sending…");
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  msg(error ? error.message : "Check your inbox for the sign-in link.");
});

/* ----------------------------------------------------------------- events */
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.filter = b.dataset.f; ls.set("agents.filter", state.filter);
  render();
});
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  state.tab = b.dataset.tab; ls.set("agents.tab", state.tab);
  render(); window.scrollTo(0, 0);
}));
$("#macPill").addEventListener("click", () => { state.tab = "apps"; ls.set("agents.tab", "apps"); render(); });

$("#views").addEventListener("click", async (e) => {
  const th = e.target.closest("[data-thread]");
  if (th) return openDetail("thread", th.dataset.thread);
  const se = e.target.closest("[data-session]");
  if (se) return openDetail("session", se.dataset.session);
  const nw = e.target.closest("[data-new]");
  if (nw) return openSheet(nw.dataset.new);
  const op = e.target.closest("[data-open]");
  if (op) return openOnMac(op.dataset.open);
  if (e.target.closest("#signOut")) { await sb.auth.signOut(); location.reload(); }
});

/* new-task sheet */
function renderPicker() {
  $("#appPicker").innerHTML = Object.entries(APPS).map(([id, a]) =>
    '<button type="button" class="pick" role="radio" data-pick="' + id + '" aria-checked="' + (state.pick === id) + '" style="--c:' + a.color + '">' +
    glyph(id, true) + a.label + "</button>").join("");
  $("#pickerNote").textContent = appOf(state.pick).how + (macOnline() ? "" : " · Mac looks offline, it will run when it's back");
}
function openSheet(app) {
  if (app) { state.pick = app; ls.set("agents.pick", app); }
  renderPicker();
  $("#sheet").hidden = false; $("#sheetBackdrop").hidden = false;
  setTimeout(() => $("#prompt").focus(), 60);
}
function closeSheet() { $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true; $("#prompt").blur(); }
$("#fab").addEventListener("click", () => openSheet(state.filter !== "all" ? state.filter : null));
$("#sheetClose").addEventListener("click", closeSheet);
$("#sheetBackdrop").addEventListener("click", closeSheet);
$("#appPicker").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b) return;
  state.pick = b.dataset.pick; ls.set("agents.pick", state.pick);
  renderPicker();
});
$("#sheet").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#prompt").value.trim();
  if (!text) return $("#prompt").focus();
  $("#sheetSend").disabled = true;
  try {
    const row = await queueTask(state.pick, text);
    $("#prompt").value = "";
    closeSheet();
    state.tab = "runs"; ls.set("agents.tab", "runs");
    render();
    openDetail("thread", row.id);
    soon();
  } catch (err) { toast("Couldn't send: " + err.message); }
  finally { $("#sheetSend").disabled = false; }
});

/* detail: reply, back, menu */
$("#back").addEventListener("click", () => closeDetail(false));
const replyText = $("#replyText");
replyText.addEventListener("input", () => autoGrow(replyText, 140));
replyText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer:fine)").matches) {
    e.preventDefault(); $("#reply").requestSubmit();
  }
});
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
    replyText.value = ""; autoGrow(replyText, 140);
    if (!resume && state.detail.kind === "thread") state.detail.key = row.id;
    state.detail.justOpened = true;
    renderDetail();
    soon();
  } catch (err) {
    toast(/resume_id/.test(err.message) ? "Follow-ups need the updated Supabase schema" : "Couldn't send: " + err.message);
  } finally { $("#replySend").disabled = false; }
});
$("#thread").addEventListener("click", (e) => {
  const f = e.target.closest("[data-full]");
  if (f) { state.full.add(f.dataset.full); renderDetail(); }
});

function menuItems() {
  const d = state.detail;
  if (!d) return [];
  if (d.kind === "thread") {
    const th = currentThread(); if (!th) return [];
    const t = th.last, a = appOf(th.app);
    const items = [["Open " + a.label + " on Mac", () => openOnMac(th.app)]];
    const withOut = th.items.filter((x) => x.output && x.action !== "open").pop();
    if (withOut) items.push(["Copy output", async () => { await navigator.clipboard.writeText(withOut.output); toast("Copied"); }]);
    if (t.action !== "open" && (t.status === "failed" || t.status === "done" || t.status === "manual")) {
      items.push(["Run again", async () => {
        const { error } = await sb.from("tasks").update({ status: "queued", output: "", exit_code: null, updated_at: now() }).eq("id", t.id);
        if (error) toast(error.message); else { toast("Queued again"); soon(); }
      }]);
    }
    items.push(["Delete", async () => {
      if (!confirm("Delete this run from your history? The session on your Mac is not touched.")) return;
      const { error } = await sb.from("tasks").delete().in("id", th.items.map((x) => x.id));
      if (error) return toast(error.message);
      state.tasks = state.tasks.filter((x) => !th.items.includes(x));
      closeDetail(false);
    }, "danger"]);
    return items;
  }
  const s = currentSession(); if (!s) return [];
  return [
    ["Open " + appOf(s.app).label + " on Mac", () => openOnMac(s.app)],
    ["Copy session ID", async () => { await navigator.clipboard.writeText(s.session_id); toast("Copied"); }],
  ];
}
$("#more").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#menu");
  if (!m.hidden) { m.hidden = true; return; }
  const items = menuItems();
  m.innerHTML = items.map((it, i) => '<button data-i="' + i + '" class="' + (it[2] || "") + '">' + esc(it[0]) + "</button>").join("");
  m._items = items;
  m.hidden = !items.length;
});
$("#menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-i]");
  if (!b) return;
  const m = $("#menu");
  m.hidden = true;
  m._items[Number(b.dataset.i)][1]();
});
document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) $("#menu").hidden = true; });
$("#prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#sheet").requestSubmit(); }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
