const MODELS = {
  claude:      { label: "Claude",      color: "#d97857" },
  codex:       { label: "Codex",       color: "#1aa382" },
  antigravity: { label: "Antigravity", color: "#528cf7" },
  deepseek:    { label: "DeepSeek",    color: "#5466f2" },
};
const STATE = {
  queued:  { text: "Queued",  color: "#8e8e93" },
  running: { text: "Running", color: "#ff9f0a" },
  done:    { text: "Done",    color: "#3dc761" },
  failed:  { text: "Failed",  color: "#fa4a40" },
  manual:  { text: "Manual",  color: "#bf5af2" },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let tasks = [];
let expanded = new Set();
let model = localStorage.getItem("queue.model") || "codex";

function ago(ts) {
  const s = Math.max(0, (Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function duration(t) {
  if (!t.created_at) return "";
  const end = t.status === "running" || t.status === "queued" ? Date.now() / 1000 : t.updated_at;
  const s = Math.max(0, Math.round(end - t.created_at));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

function render() {
  const list = $("#list");
  if (!tasks.length) {
    list.innerHTML = '<div class="empty">No tasks yet.<br>Describe one below.</div>';
    return;
  }
  list.innerHTML = tasks.map((t) => {
    const m = MODELS[t.model] || { label: t.model, color: "#8e8e93" };
    const s = STATE[t.status] || STATE.queued;
    const open = expanded.has(t.id);
    const out = open ? '<pre class="out">' + esc(t.output || "…") + "</pre>" : "";
    const openBtn = '<button data-act="open" data-id="' + t.id + '" data-model="' + t.model + '">Open ' + esc(m.label) + "</button>";
    const actions = open
      ? '<div class="cardActions">' + openBtn +
        (t.status !== "running" ? '<button data-act="retry" data-id="' + t.id + '">Retry</button>' : "") +
        '<button data-act="delete" data-id="' + t.id + '">Delete</button>' +
        (t.session_ref ? '<button data-act="session" data-ref="' + esc(t.session_ref) + '">Session ' + esc(t.session_ref.slice(0, 8)) + "…</button>" : "") +
        "</div>"
      : "";
    const manualOpen = t.status === "manual"
      ? '<div class="manualRow">' + openBtn.replace('class="', 'class="primarySmall ').replace("<button", '<button style="background:' + m.color + '22;color:' + m.color + ';border-color:' + m.color + '55"') + "</div>"
      : "";
    return (
      '<article class="card" data-id="' + t.id + '">' +
        '<div class="cardHead">' +
          '<span class="dot" style="background:' + m.color + '"></span>' +
          '<span class="title">' + esc(t.title) + "</span>" +
          '<span class="model" style="color:' + m.color + ";background:" + m.color + '2b">' + esc(m.label.toUpperCase()) + "</span>" +
          '<span class="state" style="color:' + s.color + ";background:" + s.color + '1f"><i></i>' + s.text + "</span>" +
        "</div>" +
        '<p class="meta">' + ago(t.updated_at) + " · " + duration(t) + "</p>" +
        '<p class="prompt">' + esc(t.prompt) + "</p>" +
        manualOpen + out + actions +
      "</article>"
    );
  }).join("");
}

async function load() {
  try {
    const r = await fetch("api/tasks", { cache: "no-store" });
    const d = await r.json();
    tasks = d.tasks || [];
    $("#sub").textContent = tasks.length + (tasks.length === 1 ? " task" : " tasks") +
      " · " + tasks.filter((t) => t.status === "running").length + " running";
    render();
  } catch (e) {
    $("#sub").textContent = "offline — retrying";
  }
}

function buildChips() {
  $("#chips").innerHTML = Object.entries(MODELS).map(([id, m]) =>
    '<button type="button" class="chip" data-model="' + id + '" aria-pressed="' + (id === model) + '"' +
    (id === model ? ' style="background:' + m.color + ';color:#fff"' : "") + ">" + m.label + "</button>"
  ).join("");
}

$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-model]");
  if (!b) return;
  model = b.dataset.model;
  localStorage.setItem("queue.model", model);
  buildChips();
});

const promptEl = $("#prompt");
promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(120, promptEl.scrollHeight) + "px";
});
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); }
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;
  $("#send").disabled = true;
  try {
    await fetch("api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text, model }),
    });
    promptEl.value = "";
    promptEl.style.height = "auto";
    await load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    $("#send").disabled = false;
  }
});

$("#list").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]");
  if (act) {
    e.stopPropagation();
    const id = act.dataset.id;
    if (act.dataset.act === "open") {
      act.disabled = true;
      const r = await fetch("api/open", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: act.dataset.model }),
      });
      act.textContent = r.ok ? "Opened ✓" : "App not found";
      setTimeout(() => { act.disabled = false; act.textContent = "Open " + (MODELS[act.dataset.model]?.label || ""); }, 2000);
      return;
    }
    if (act.dataset.act === "retry") await fetch("api/tasks/" + id + "/retry", { method: "POST" });
    if (act.dataset.act === "delete") { await fetch("api/tasks/" + id, { method: "DELETE" }); expanded.delete(id); }
    await load();
    return;
  }
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  render();
});

// settings
$("#gear").onclick = async () => {
  const s = await (await fetch("api/settings")).json();
  $("#workdir").value = s.workdir || "";
  $("#sbUrl").value = s.supabase_url || "";
  $("#sbKey").value = "";
  $("#sbKey").placeholder = s.has_key ? "•••• saved" : "eyJhbGciOi…";
  $("#sheet").hidden = false;
};
$("#closeSheet").onclick = () => { $("#sheet").hidden = true; };
$("#sheet").onclick = (e) => { if (e.target.id === "sheet") $("#sheet").hidden = true; };
$("#saveSettings").onclick = async () => {
  const body = { workdir: $("#workdir").value, supabase_url: $("#sbUrl").value };
  if ($("#sbKey").value.trim()) body.supabase_key = $("#sbKey").value.trim();
  await fetch("api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  $("#saveState").textContent = "Saved.";
  setTimeout(() => { $("#sheet").hidden = true; $("#saveState").textContent = ""; }, 700);
};

buildChips();
load();
setInterval(() => { if (!document.hidden) load(); }, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
