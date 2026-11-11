const MODELS = {
  claude:      { label: "Claude",      color: "#e07a5f" },
  codex:       { label: "Codex",       color: "#2fbf9a" },
  antigravity: { label: "Antigravity", color: "#5b8def" },
  deepseek:    { label: "DeepSeek",    color: "#6f7cff" },
};
const STATE = {
  queued:  { text: "Queued",  color: "#9aa1b1" },
  running: { text: "Running", color: "#ffb340" },
  done:    { text: "Done",    color: "#3ddc84" },
  failed:  { text: "Failed",  color: "#ff6b66" },
  manual:  { text: "Manual",  color: "#c084fc" },
};

const $ = function (s) { return document.querySelector(s); };
const esc = function (s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
};

const store = {
  get cfg() {
    try { return JSON.parse(localStorage.getItem("queue.cfg") || "null"); } catch (e) { return null; }
  },
  set cfg(v) { localStorage.setItem("queue.cfg", JSON.stringify(v)); },
  get session() {
    try { return JSON.parse(localStorage.getItem("queue.auth") || "null"); } catch (e) { return null; }
  },
  set session(v) {
    if (v) localStorage.setItem("queue.auth", JSON.stringify(v));
    else localStorage.removeItem("queue.auth");
  },
};

let tasks = [];
let expanded = new Set();
let showAll = new Set();
let model = localStorage.getItem("queue.model") || "codex";
let appFilter = localStorage.getItem("queue.app") || "all";
let timer = null;

function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function duration(t) {
  if (!t.created_at) return "";
  const end = (t.status === "running" || t.status === "queued") ? Date.now() / 1000 : t.updated_at;
  const s = Math.max(0, Math.round(end - t.created_at));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

function fmt(text) {
  let s = esc(text || "");
  s = s.replace(/\r/g, "");
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function (m, lang, code) { return "<pre class='code'>" + code + "</pre>"; });
  s = s.replace(/^#{1,6}\s+(.*)$/gm, "<strong class='h'>$1</strong>");
  s = s.replace(/^\s*[-*]\s+(.*)$/gm, "<span class='li'>• $1</span>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return s;
}

function headers(extra) {
  const cfg = store.cfg, session = store.session;
  return Object.assign({
    apikey: cfg.anonKey,
    Authorization: "Bearer " + (session && session.access_token ? session.access_token : cfg.anonKey),
    "Content-Type": "application/json",
  }, extra || {});
}

async function api(path, options) {
  const cfg = store.cfg;
  const res = await fetch(cfg.url + path, Object.assign({ headers: headers() }, options || {}));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) throw new Error((body && (body.msg || body.message || body.error_description)) || String(res.status));
  return body;
}

function show(section) {
  ["setup", "auth"].forEach(function (id) { document.getElementById(id).hidden = id !== section; });
  const signedIn = !!store.session;
  $("#apps").hidden = section !== "tasks";
  $("#viewRow").hidden = section !== "tasks";
  $("#list").hidden = section !== "tasks";
  $("#composer").hidden = section !== "tasks";
  $("#signOut").hidden = !signedIn;
}

function renderApps() {
  const items = [["all", { label: "All", color: "#8b90a0" }]].concat(Object.entries(MODELS));
  $("#apps").innerHTML = items.map(function (pair) {
    const id = pair[0], m = pair[1];
    return '<button class="appBtn" data-app="' + id + '" aria-pressed="' + (appFilter === id) + '">' +
      '<span class="appDot" style="--c:' + m.color + '"></span>' + m.label + "</button>";
  }).join("");
}

function render() {
  const list = $("#list");
  const shown = appFilter === "all" ? tasks : tasks.filter(function (t) { return t.model === appFilter; });
  $("#viewCount").textContent = shown.length ? shown.length + " total" : "";
  if (!shown.length) {
    list.innerHTML = '<div class="empty">' +
      (appFilter === "all" ? "Nothing queued yet.<br>Describe a task below." :
        "Nothing queued for " + esc(MODELS[appFilter].label) + " yet.") + "</div>";
    return;
  }
  list.innerHTML = shown.map(function (t) {
    const m = MODELS[t.model] || { label: t.model, color: "#8b90a0" };
    const s = STATE[t.status] || STATE.queued;
    const isOpen = expanded.has(t.id);
    const raw = t.output || "";
    const truncated = !showAll.has(t.id) && raw.length > 3500;
    const text = truncated ? raw.slice(0, 3500) : raw;
    const out = isOpen && raw
      ? '<div class="out">' + fmt(text) +
        (truncated ? '<button class="fade" data-act="showall" data-id="' + t.id + '">Show full output (' + raw.length.toLocaleString() + " chars)</button>" : "") +
        "</div>"
      : "";
    const actions = isOpen
      ? '<div class="actions">' +
        '<button class="accent" data-act="open" data-model="' + t.model + '">Open ' + esc(m.label) + "</button>" +
        (t.action === "open" ? "" : (t.status === "running" || t.status === "queued" ? "" : '<button data-act="retry" data-id="' + t.id + '">Retry</button>')) +
        (raw ? '<button data-act="copy" data-id="' + t.id + '">Copy output</button>' : "") +
        '<button data-act="delete" data-id="' + t.id + '">Delete</button>' +
        "</div>"
      : "";
    const hint = !isOpen && raw ? '<p class="meta">' + (t.status === "failed" ? "Failed · tap to see why" : "Tap to read the output") + "</p>" : "";
    return '<article class="card' + (isOpen ? " open" : "") + '" data-id="' + t.id + '">' +
      '<div class="cardHead">' +
        '<span class="dot" style="background:' + m.color + '"></span>' +
        '<span class="title">' + esc(t.title || t.prompt) + "</span>" +
        '<span class="state" style="color:' + s.color + ";background:" + s.color + '1a"><i></i>' + s.text + "</span>" +
      "</div>" +
      '<p class="meta">' + esc(m.label) + " · " + ago(t.updated_at || t.created_at) +
        (duration(t) ? " · " + duration(t) : "") + "</p>" +
      '<p class="prompt">' + esc(t.prompt || "App command") + "</p>" + hint + out + actions +
      "</article>";
  }).join("");
}

async function load() {
  try {
    tasks = await api("/rest/v1/tasks?select=*&order=created_at.desc&limit=100");
    const running = tasks.filter(function (t) { return t.status === "running"; }).length;
    $("#sub").textContent = (store.session && store.session.user && store.session.user.email ? store.session.user.email : "signed in") +
      " · " + tasks.length + (tasks.length === 1 ? " task" : " tasks") + (running ? " · " + running + " running" : "");
    render();
  } catch (e) {
    $("#sub").textContent = "offline — " + e.message;
  }
}

function buildChips() {
  $("#chips").innerHTML = Object.entries(MODELS).map(function (pair) {
    const id = pair[0], m = pair[1];
    return '<button type="button" class="chip" data-model="' + id + '" aria-pressed="' + (id === model) + '"' +
      (id === model ? ' style="background:' + m.color + '"' : "") + ">" + m.label + "</button>";
  }).join("");
}

function bakedConfig() {
  const c = window.QUEUE_CONFIG;
  if (!c || !c.url || !c.anonKey || c.url.indexOf("__") === 0) return null;
  return c;
}

function jwtEmail(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part)).email || "";
  } catch (e) { return ""; }
}

function adoptHashSession() {
  if (!location.hash || location.hash.length < 10) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("error_description")) {
    alert(p.get("error_description"));
    history.replaceState(null, "", location.pathname);
    return false;
  }
  const token = p.get("access_token");
  if (!token) return false;
  store.session = {
    access_token: token,
    refresh_token: p.get("refresh_token"),
    expires_at: Date.now() / 1000 + Number(p.get("expires_in") || 3600),
    user: { id: p.get("user_id") || "", email: jwtEmail(token) },
  };
  history.replaceState(null, "", location.pathname);
  return true;
}

function boot() {
  const baked = bakedConfig();
  if (baked && !store.cfg) store.cfg = baked;
  adoptHashSession();
  const cfg = store.cfg;
  if (!cfg || !cfg.url || !cfg.anonKey) { show("setup"); $("#sub").textContent = "setup needed"; return; }
  if (!store.session) { show("auth"); $("#sub").textContent = "sign in"; return; }
  show("tasks");
  renderApps();
  load();
  if (timer) clearInterval(timer);
  timer = setInterval(function () { if (!document.hidden) load(); }, 3000);
}

$("#saveCfg").onclick = function () {
  const url = $("#cfgUrl").value.trim().replace(/\/$/, "");
  const anonKey = $("#cfgKey").value.trim();
  if (!url || !anonKey) return;
  store.cfg = { url: url, anonKey: anonKey };
  boot();
};

async function authRequest() {
  const cfg = store.cfg;
  const res = await fetch(cfg.url + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: $("#email").value.trim(), password: $("#password").value }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.msg || "sign-in failed");
  return body;
}

$("#signIn").onclick = async function () {
  try {
    $("#authState").textContent = "signing in…";
    store.session = await authRequest();
    $("#sub").textContent = "loading…";
    boot();
  } catch (e) { $("#authState").textContent = e.message; }
};

$("#signUp").onclick = async function () {
  const cfg = store.cfg;
  try {
    $("#authState").textContent = "creating account…";
    const res = await fetch(cfg.url + "/auth/v1/signup", {
      method: "POST",
      headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("#email").value.trim(), password: $("#password").value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.msg || body.error_description || "sign-up failed");
    if (body.access_token) { store.session = body; boot(); }
    else $("#authState").textContent = "Check your email to confirm, then sign in.";
  } catch (e) { $("#authState").textContent = e.message; }
};

$("#magicLink").onclick = async function () {
  const cfg = store.cfg;
  const email = $("#email").value.trim();
  if (!email) { $("#authState").textContent = "Enter your email first."; return; }
  try {
    $("#authState").textContent = "sending…";
    const res = await fetch(cfg.url + "/auth/v1/otp", {
      method: "POST",
      headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, create_user: true, options: { email_redirect_to: location.origin + location.pathname } }),
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.msg || body.error_description || "could not send");
    $("#authState").textContent = "Check your inbox for the link.";
  } catch (e) { $("#authState").textContent = e.message; }
};

$("#signOut").onclick = function () { store.session = null; boot(); };

$("#apps").addEventListener("click", function (e) {
  const b = e.target.closest(".appBtn");
  if (!b) return;
  appFilter = b.dataset.app;
  localStorage.setItem("queue.app", appFilter);
  renderApps();
  render();
});

$("#chips").addEventListener("click", function (e) {
  const b = e.target.closest("[data-model]");
  if (!b) return;
  model = b.dataset.model;
  localStorage.setItem("queue.model", model);
  buildChips();
});

const promptEl = $("#prompt");
promptEl.addEventListener("input", function () {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(130, promptEl.scrollHeight) + "px";
});
promptEl.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); }
});

$("#composer").addEventListener("submit", async function (e) {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;
  const now = Date.now() / 1000;
  $("#send").disabled = true;
  try {
    await api("/rest/v1/tasks", {
      method: "POST",
      body: JSON.stringify([{
        id: "t_" + Math.random().toString(16).slice(2, 14),
        title: text.split("\n")[0].slice(0, 90),
        prompt: text, model: model, status: "queued", output: "",
        action: "run", created_at: now, updated_at: now,
        owner: store.session.user.id || null,
      }]),
    });
    promptEl.value = "";
    promptEl.style.height = "auto";
    await load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    alert("Could not queue: " + err.message);
  } finally { $("#send").disabled = false; }
});

$("#list").addEventListener("click", async function (e) {
  const act = e.target.closest("[data-act]");
  if (act) {
    e.stopPropagation();
    const id = act.dataset.id;
    if (act.dataset.act === "copy") {
      const t = tasks.find(function (x) { return x.id === id; });
      if (t) { await navigator.clipboard.writeText(t.output || ""); act.textContent = "Copied"; }
      return;
    }
    if (act.dataset.act === "showall") { showAll.add(id); render(); return; }
    if (act.dataset.act === "delete") {
      await api("/rest/v1/tasks?id=eq." + encodeURIComponent(id), { method: "DELETE" });
      expanded.delete(id);
      await load(); return;
    }
    if (act.dataset.act === "retry") {
      await api("/rest/v1/tasks?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ status: "queued", output: "", exit_code: null, updated_at: Date.now() / 1000 }),
      });
      await load(); return;
    }
    if (act.dataset.act === "open") {
      const now = Date.now() / 1000;
      await api("/rest/v1/tasks", {
        method: "POST",
        body: JSON.stringify([{
          id: "t_" + Math.random().toString(16).slice(2, 14),
          title: "Open " + (MODELS[act.dataset.model] || {}).label,
          prompt: "", model: act.dataset.model, status: "queued", output: "",
          action: "open", created_at: now, updated_at: now,
          owner: store.session.user.id || null,
        }]),
      });
      act.textContent = "Opening on Mac…";
      setTimeout(load, 1500);
      return;
    }
    return;
  }
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  render();
});

buildChips();
boot();
