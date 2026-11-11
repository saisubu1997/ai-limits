// Hosted work queue: Supabase auth + Postgres as the bus, the Mac as the runner.
const MODELS = {
  claude: { label: "Claude", color: "#d97857" },
  codex: { label: "Codex", color: "#1aa382" },
  antigravity: { label: "Antigravity", color: "#528cf7" },
  deepseek: { label: "DeepSeek", color: "#5466f2" },
};
const STATE = {
  queued: { text: "Queued", color: "#8e8e93" },
  running: { text: "Running", color: "#ff9f0a" },
  done: { text: "Done", color: "#3dc761" },
  failed: { text: "Failed", color: "#fa4a40" },
  manual: { text: "Manual", color: "#bf5af2" },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const store = {
  get cfg() {
    try { return JSON.parse(localStorage.getItem("queue.cfg") || "null"); } catch { return null; }
  },
  set cfg(v) { localStorage.setItem("queue.cfg", JSON.stringify(v)); },
  get session() {
    try { return JSON.parse(localStorage.getItem("queue.auth") || "null"); } catch { return null; }
  },
  set session(v) {
    v ? localStorage.setItem("queue.auth", JSON.stringify(v)) : localStorage.removeItem("queue.auth");
  },
};

let tasks = [];
let expanded = new Set();
let model = localStorage.getItem("queue.hosted.model") || "codex";

function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function headers(extra) {
  const cfg = store.cfg, session = store.session;
  return Object.assign({
    apikey: cfg.anonKey,
    Authorization: "Bearer " + (session ? session.access_token : cfg.anonKey),
    "Content-Type": "application/json",
  }, extra || {});
}

async function api(path, options) {
  const cfg = store.cfg;
  const res = await fetch(cfg.url + path, Object.assign({ headers: headers() }, options || {}));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error((body && (body.msg || body.message || body.error_description)) || res.status);
  return body;
}

function show(section) {
  ["setup", "auth"].forEach((id) => { document.getElementById(id).hidden = id !== section; });
  const signedIn = !!store.session;
  $("#list").hidden = section !== "tasks" || !signedIn;
  $("#composer").hidden = !(section === "tasks" && signedIn);
  $("#signOut").hidden = !signedIn;
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
  } catch { return ""; }
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
  $("#sub").textContent = (store.session.user && store.session.user.email) || "signed in";
  show("tasks");
  load();
  setInterval(() => { if (!document.hidden) load(); }, 3000);
}

$("#saveCfg").onclick = () => {
  const url = $("#cfgUrl").value.trim().replace(/\/$/, "");
  const anonKey = $("#cfgKey").value.trim();
  if (!url || !anonKey) { return; }
  store.cfg = { url, anonKey };
  boot();
};

async function authRequest(grant) {
  const cfg = store.cfg;
  const res = await fetch(cfg.url + "/auth/v1/token?grant_type=" + grant, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: $("#email").value.trim(), password: $("#password").value }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.msg || "sign-in failed");
  return body;
}

$("#signIn").onclick = async () => {
  try {
    $("#authState").textContent = "signing in…";
    const session = await authRequest("password");
    store.session = session;
    $("#authState").textContent = "";
    boot();
  } catch (e) { $("#authState").textContent = e.message; }
};

$("#signUp").onclick = async () => {
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

$("#signOut").onclick = () => { store.session = null; boot(); };

$("#magicLink").onclick = async () => {
  const cfg = store.cfg;
  const email = $("#email").value.trim();
  if (!email) { $("#authState").textContent = "Enter your email first."; return; }
  try {
    $("#authState").textContent = "sending…";
    const res = await fetch(cfg.url + "/auth/v1/otp", {
      method: "POST",
      headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        create_user: true,
        options: { email_redirect_to: location.origin + location.pathname },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.msg || body.error_description || "could not send");
    $("#authState").textContent = "Check your inbox for the link.";
  } catch (e) { $("#authState").textContent = e.message; }
};

function render() {
  const list = $("#list");
  if (!tasks.length) { list.innerHTML = '<div class="empty">No tasks yet.<br>Describe one below.</div>'; return; }
  list.innerHTML = tasks.map((t) => {
    const m = MODELS[t.model] || { label: t.model, color: "#8e8e93" };
    const s = STATE[t.status] || STATE.queued;
    const open = expanded.has(t.id);
    const out = open && t.output ? '<pre class="out">' + esc(t.output) + "</pre>" : "";
    return '<article class="card" data-id="' + t.id + '">' +
      '<div class="cardHead"><span class="dot" style="background:' + m.color + '"></span>' +
      '<span class="title">' + esc(t.title) + "</span>" +
      '<span class="model" style="color:' + m.color + ";background:" + m.color + '2b">' + esc(m.label.toUpperCase()) + "</span>" +
      '<span class="state" style="color:' + s.color + ";background:" + s.color + '1f"><i></i>' + s.text + "</span></div>" +
      '<p class="meta">' + ago(t.updated_at || t.created_at) + "</p>" +
      '<p class="prompt">' + esc(t.prompt) + "</p>" + out + "</article>";
  }).join("");
}

async function load() {
  try {
    tasks = await api("/rest/v1/tasks?select=*&order=created_at.desc&limit=100");
    $("#sub").textContent = (store.session.user.email || "signed in") + " · " + tasks.length + " tasks";
    render();
  } catch (e) { $("#sub").textContent = "offline: " + e.message; }
}

function buildChips() {
  $("#chips").innerHTML = Object.entries(MODELS).map(([id, m]) =>
    '<button type="button" class="chip" data-model="' + id + '" aria-pressed="' + (id === model) + '"' +
    (id === model ? ' style="background:' + m.color + ';color:#fff"' : "") + ">" + m.label + "</button>").join("");
}

$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-model]");
  if (!b) return;
  model = b.dataset.model;
  localStorage.setItem("queue.hosted.model", model);
  buildChips();
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#prompt").value.trim();
  if (!text) return;
  const id = "t_" + Math.random().toString(16).slice(2, 14);
  const now = Date.now() / 1000;
  try {
    await api("/rest/v1/tasks", {
      method: "POST",
      body: JSON.stringify([{
        id, title: text.split("\n")[0].slice(0, 90), prompt: text, model,
        status: "queued", output: "", action: "run", created_at: now, updated_at: now,
        owner: store.session.user.id,
      }]),
    });
    $("#prompt").value = "";
    load();
  } catch (err) { alert("Could not queue: " + err.message); }
});

$("#list").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  expanded.has(card.dataset.id) ? expanded.delete(card.dataset.id) : expanded.add(card.dataset.id);
  render();
});

if (location.pathname.endsWith(".html") && !location.pathname.endsWith("/")) {
  // served from Supabase Storage: keep working as a single file
  document.querySelectorAll('link[rel="manifest"]').forEach((l) => l.remove());
}
buildChips();
boot();
