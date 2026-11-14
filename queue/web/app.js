const MODELS = {
  claude:      { label: "Claude",      vendor: "Anthropic", color: "#e07a5f", initial: "C" },
  codex:       { label: "Codex",       vendor: "OpenAI",    color: "#2fbf9a", initial: "G" },
  antigravity: { label: "Antigravity", vendor: "Google",    color: "#5b8def", initial: "A" },
  deepseek:    { label: "DeepSeek",    vendor: "DeepSeek",  color: "#6f7cff", initial: "D" },
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

let tasks = [];
let sessionsData = {};
let limitsData = null;
let canResume = {};
let expanded = new Set();
let showAll = new Set();
let model = localStorage.getItem("queue.model") || "codex";
let appFilter = localStorage.getItem("queue.app") || "all";
let tab = "dashboard";
let continueTarget = null;
let queueMinRemaining = 10.0;

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

function formatReset(resetAt) {
  if (!resetAt) return "";
  const target = new Date(resetAt).getTime();
  if (isNaN(target)) return "";
  const diffSec = Math.round((target - Date.now()) / 1000);
  if (diffSec <= 0) return "resets now";
  const m = Math.floor(diffSec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return "resets in " + d + "d " + (h % 24) + "h";
  if (h > 0) return "resets in " + h + "h " + (m % 60) + "m";
  return "resets in " + m + "m";
}

function fmt(text) {
  let s = esc(text || "");
  s = s.replace(/\r/g, "");
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function (m, lang, code) {
    return "<pre class='code'>" + code + "</pre>";
  });
  s = s.replace(/^#{1,6}\s+(.*)$/gm, "<strong class='h'>$1</strong>");
  s = s.replace(/^\s*[-*]\s+(.*)$/gm, "<span class='li'>• $1</span>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return s;
}

function isModelAtCapacity(modelKey) {
  if (!limitsData || !limitsData.providers) return false;
  const p = limitsData.providers.find(function (x) { return x.id === modelKey; });
  if (!p) return false;
  if (modelKey === "deepseek") {
    for (const m of (p.metrics || [])) {
      if (m.value_text) {
        const val = parseFloat(m.value_text.replace(/[^0-9.]/g, ""));
        if (!isNaN(val) && val <= 0.10) return true;
      }
    }
    return false;
  }
  for (const m of (p.metrics || [])) {
    if (m.remaining_pct != null && m.remaining_pct < queueMinRemaining) {
      return true;
    }
  }
  return false;
}

function getProvider(modelKey) {
  if (!limitsData || !limitsData.providers) return null;
  return limitsData.providers.find(function (x) { return x.id === modelKey; }) || null;
}

function renderApps() {
  const el = $("#apps");
  const items = [["all", { label: "All", color: "#8b90a0" }]].concat(Object.entries(MODELS));
  el.innerHTML = items.map(function (pair) {
    const id = pair[0], m = pair[1];
    const isAtCap = id !== "all" && isModelAtCapacity(id);
    return '<button class="appBtn' + (isAtCap ? " atCap" : "") + '" data-app="' + id + '" aria-pressed="' + (appFilter === id) + '">' +
      '<span class="appDot" style="--c:' + m.color + '"></span>' + m.label +
      (isAtCap ? '<span class="warnPip" title="At capacity">!</span>' : '') + "</button>";
  }).join("");
}

function renderDashboard() {
  const dash = $("#dashboard");
  const shownModels = appFilter === "all" ? Object.keys(MODELS) : [appFilter];

  // Summary counts
  const totalQueued = tasks.filter(function (t) { return t.status === "queued"; }).length;
  const totalRunning = tasks.filter(function (t) { return t.status === "running"; }).length;
  const totalDone = tasks.filter(function (t) { return t.status === "done"; }).length;
  const totalFailed = tasks.filter(function (t) { return t.status === "failed"; }).length;

  let html = '';

  // Top summary bar
  html += '<div class="dashSummary">' +
    '<div class="summaryPill"><span class="sumDot live"></span>Mac connected</div>' +
    '<div class="summaryStats">' +
      '<span class="sumItem"><b>' + totalQueued + '</b> Queued</span>' +
      '<span class="sumItem"><b>' + totalRunning + '</b> Running</span>' +
      '<span class="sumItem"><b>' + totalDone + '</b> Done</span>' +
      (totalFailed ? '<span class="sumItem red"><b>' + totalFailed + '</b> Failed</span>' : '') +
    '</div>' +
  '</div>';

  // Agent cards
  shownModels.forEach(function (key) {
    const meta = MODELS[key] || { label: key, vendor: "", color: "#8b90a0", initial: key[0].toUpperCase() };
    const p = getProvider(key);
    const atCap = isModelAtCapacity(key);
    const queuedCount = tasks.filter(function (t) { return t.model === key && t.status === "queued"; }).length;
    const runningCount = tasks.filter(function (t) { return t.model === key && t.status === "running"; }).length;

    // Status state
    let stateLabel = "Idle";
    let stateClass = "idle";
    if (runningCount > 0 || (p && p.status && p.status.state === "working")) {
      stateLabel = "Working";
      stateClass = "working";
    } else if (p && p.status && p.status.running) {
      stateLabel = "Running";
      stateClass = "running";
    } else if (p && !p.ok && p.error) {
      stateLabel = "Offline";
      stateClass = "error";
    }

    const planTag = (p && p.plan) ? '<span class="planBadge">' + esc(p.plan.toUpperCase()) + '</span>' : '';
    const vendorLabel = (p && p.vendor) ? p.vendor : meta.vendor;
    const activityIndicator = (stateClass === "working") ? '<span class="activityBars"><span></span><span></span><span></span></span>' : '';

    html += '<article class="dashCard is-' + stateClass + '" data-model="' + key + '">' +
      '<div class="dashHead">' +
        '<div class="avatar" style="background:' + meta.color + '">' + meta.initial + '</div>' +
        '<div class="dashTitleGroup">' +
          '<div class="dashTitleRow">' +
            '<span class="dashName">' + esc(meta.label) + '</span>' + planTag +
          '</div>' +
          '<span class="dashVendor">' + esc(vendorLabel) + '</span>' +
        '</div>' +
        '<span class="dashBadge ' + stateClass + '"><i></i>' + stateLabel + activityIndicator + '</span>' +
      '</div>';

    // Metrics / credit bars
    if (p && p.metrics && p.metrics.length > 0) {
      html += '<div class="metricsList">';
      p.metrics.forEach(function (m) {
        const remaining = m.remaining_pct != null ? m.remaining_pct : (m.used_pct != null ? 100 - m.used_pct : null);
        const resetStr = formatReset(m.reset_at);
        const sub = [m.sublabel, resetStr].filter(Boolean).join(" · ");

        // Color coding: green if > 40%, amber if 15-40%, red if < 15%
        let barColor = "#3ddc84";
        let textClass = "green";
        if (remaining != null) {
          if (remaining < 15) { barColor = "#ff6b66"; textClass = "red"; }
          else if (remaining <= 40) { barColor = "#ffb340"; textClass = "amber"; }
        }

        let rightValue = "";
        if (remaining != null) {
          rightValue = '<span class="metricVal ' + textClass + '">' + Math.round(remaining) + '% left</span>';
        } else if (m.value_text) {
          rightValue = '<span class="metricVal green">' + esc(m.value_text) + ' left</span>';
        }

        html += '<div class="metricRow">' +
          '<div class="metricLabels">' +
            '<span class="metricName">' + esc(m.label) + '</span>' + rightValue +
          '</div>' +
          (remaining != null ? (
            '<div class="metricTrack">' +
              '<div class="metricFill" style="width:' + Math.max(3, Math.min(100, remaining)) + '%;background:' + barColor + '"></div>' +
            '</div>'
          ) : '') +
          (sub ? '<div class="metricSub">' + esc(sub) + '</div>' : '') +
        '</div>';
      });
      html += '</div>';
    } else if (p && p.error) {
      html += '<div class="dashError">' + esc(p.error) + '</div>';
    }

    // Queue status banner inside card
    if (atCap) {
      html += '<div class="capAlert">⚠️ Low credits: Queued tasks will auto-execute when limits reset</div>';
    }
    if (queuedCount > 0) {
      html += '<div class="queueInfo">⏱ ' + queuedCount + ' task' + (queuedCount > 1 ? 's' : '') + ' queued for ' + esc(meta.label) + '</div>';
    }

    // Quick action buttons
    html += '<div class="dashActions">' +
      '<button class="dashBtn primary" data-act="quicknew" data-model="' + key + '">New Task</button>' +
      '<button class="dashBtn" data-act="open" data-model="' + key + '">Open on Mac</button>' +
    '</div>';

    html += '</article>';
  });

  dash.innerHTML = html;
}

function renderTasks() {
  const list = $("#list");
  const shown = appFilter === "all" ? tasks : tasks.filter(function (t) { return t.model === appFilter; });
  $("#viewCount").textContent = shown.length ? shown.length + " total" : "";
  if (!shown.length) {
    list.innerHTML = '<div class="empty">' +
      (appFilter === "all" ? "No tasks yet.<br>Describe one below to get started." :
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
    const isAtCap = t.status === "queued" && isModelAtCapacity(t.model);

    // Queue position badge
    let qBadge = "";
    if (t.status === "queued") {
      const pos = t.queue_position != null ? ("#" + t.queue_position + " in queue") : "Queued";
      qBadge = '<span class="queuePos">' + pos + '</span>';
    }

    const out = isOpen && raw
      ? '<div class="out">' + fmt(text) +
        (truncated ? '<button class="fade" data-act="showall" data-id="' + t.id + '">Show full output (' + raw.length.toLocaleString() + " chars)</button>" : "") +
        "</div>"
      : "";
    const actions = isOpen
      ? '<div class="actions">' +
        '<button class="accent" data-act="open" data-model="' + t.model + '">Open ' + esc(m.label) + "</button>" +
        (t.session_ref ? '<button class="accent" data-act="resume" data-id="' + t.id + '" data-model="' + t.model + '" data-ref="' + esc(t.session_ref) + '">Continue in ' + esc(m.label) + "</button>" : "") +
        (t.status !== "running" && t.status !== "manual" ? '<button data-act="retry" data-id="' + t.id + '">Retry</button>' : "") +
        (raw ? '<button data-act="copy" data-id="' + t.id + '">Copy output</button>' : "") +
        '<button data-act="delete" data-id="' + t.id + '">Delete</button>' +
        "</div>"
      : "";
    const hint = !isOpen && raw ? '<p class="meta">' + (t.status === "failed" ? "Failed · tap to see why" : "Tap to read the output") + "</p>" : "";

    return '<article class="card' + (isOpen ? " open" : "") + '" data-id="' + t.id + '">' +
      '<div class="cardHead">' +
        '<span class="dot" style="background:' + m.color + '"></span>' +
        '<span class="title">' + esc(t.title || t.prompt) + "</span>" +
        qBadge +
        '<span class="state" style="color:' + s.color + ";background:" + s.color + '1a"><i></i>' + s.text + "</span>" +
      "</div>" +
      (isAtCap ? '<div class="cardCapWarn">Waiting for ' + esc(m.label) + ' credits to reset before executing</div>' : '') +
      '<p class="meta">' + esc(m.label) + " · " + ago(t.updated_at || t.created_at) +
        (duration(t) ? " · " + duration(t) : "") + "</p>" +
      '<p class="prompt">' + esc(t.prompt) + "</p>" + hint + out + actions +
      "</article>";
  }).join("");
}

function renderSessions() {
  const box = $("#sessions");
  const order = appFilter === "all" ? ["claude", "codex", "deepseek", "antigravity"] : [appFilter];
  let html = "";
  let total = 0;
  order.forEach(function (app) {
    const list = sessionsData[app] || [];
    const m = MODELS[app] || { label: app, color: "#8b90a0" };
    total += list.length;
    if (appFilter === "all") {
      html += '<div class="groupTitle">' + m.label + " · " + list.length + "</div>";
    }
    if (!list.length) {
      html += '<div class="sess"><div class="sessBody"><div class="sessTitle" style="color:var(--dim2)">No chats found</div>' +
        '<div class="sessMeta">' + (app === "antigravity"
          ? "Antigravity keeps no readable chat list"
          : "Start one in " + m.label + " and it appears here") + "</div></div></div>";
      return;
    }
    list.forEach(function (s) {
      const resume = canResume[app]
        ? '<button class="miniBtn" data-act="continue" data-app="' + app + '" data-id="' + s.id +
          '" data-title="' + encodeURIComponent(s.title) + '">Continue</button>'
        : "";
      html += '<article class="sess">' +
        '<span class="dot" style="background:' + m.color + '"></span>' +
        '<div class="sessBody"><div class="sessTitle">' + esc(s.title) + "</div>" +
        '<div class="sessMeta">' + ago(s.updated_at) + " · " + s.id.slice(0, 8) + "</div></div>" +
        '<div class="sessBtns"><button class="miniBtn" data-act="openapp" data-app="' + app + '">Open</button>' + resume + "</div>" +
        "</article>";
    });
  });
  $("#viewCount").textContent = total ? total + " chats" : "";
  box.innerHTML = html;
}

function render() {
  if (tab === "dashboard") renderDashboard();
  else if (tab === "tasks") renderTasks();
  else renderSessions();
}

async function load() {
  try {
    const [tasksRes, limitsRes] = await Promise.all([
      fetch("api/tasks", { cache: "no-store" }),
      fetch("api/limits", { cache: "no-store" }).catch(function () { return null; }),
    ]);

    if (tasksRes.ok) {
      const d = await tasksRes.json();
      tasks = d.tasks || [];
      const running = tasks.filter(function (t) { return t.status === "running"; }).length;
      const queued = tasks.filter(function (t) { return t.status === "queued"; }).length;
      let subText = tasks.length + (tasks.length === 1 ? " task" : " tasks");
      if (running) subText += " · " + running + " running";
      if (queued) subText += " · " + queued + " queued";
      $("#sub").textContent = subText;
    }

    if (limitsRes && limitsRes.ok) {
      limitsData = await limitsRes.json();
    }

    renderApps();
    buildChips();
    render();
  } catch (e) {
    $("#sub").textContent = "offline — retrying";
  }
}

async function loadSessions() {
  const box = $("#sessions");
  if (!box.innerHTML) box.innerHTML = '<div class="empty">Loading chats…</div>';
  try {
    const r = await fetch("api/sessions", { cache: "no-store" });
    const d = await r.json();
    sessionsData = d.sessions || {};
    canResume = d.can_resume || {};
    renderSessions();
  } catch (e) {
    box.innerHTML = '<div class="empty">Cannot reach the Mac</div>';
  }
}

function switchTab(name) {
  tab = name;
  document.querySelectorAll(".view").forEach(function (v) {
    v.setAttribute("aria-selected", String(v.dataset.tab === name));
  });
  $("#dashboard").hidden = name !== "dashboard";
  $("#list").hidden = name !== "tasks";
  $("#sessions").hidden = name !== "sessions";
  if (name === "sessions") loadSessions();
  else render();
}

function buildChips() {
  $("#chips").innerHTML = Object.entries(MODELS).map(function (pair) {
    const id = pair[0], m = pair[1];
    const isAtCap = isModelAtCapacity(id);
    return '<button type="button" class="chip' + (isAtCap ? " capWarning" : "") + '" data-model="' + id + '" aria-pressed="' + (id === model) + '"' +
      (id === model ? ' style="background:' + m.color + '"' : "") + ">" +
      m.label + (isAtCap ? ' <span class="capDot" title="Credits low - will queue">!</span>' : '') + "</button>";
  }).join("");
}

async function openApp(app) {
  try {
    const r = await fetch("api/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: app }),
    });
    if (!r.ok) alert("That app is not installed on the Mac");
  } catch (e) { alert("Could not reach the Mac"); }
}

function startContinue(app, id, title) {
  continueTarget = { app: app, id: id, title: title };
  model = app;
  localStorage.setItem("queue.model", model);
  buildChips();
  switchTab("tasks");
  updateTarget();
  $("#prompt").focus();
}

function updateTarget() {
  const bar = $("#target");
  if (!bar) return;
  bar.hidden = !continueTarget;
  if (continueTarget) {
    $("#targetLabel").textContent =
      "Continuing " + (MODELS[continueTarget.app] || {}).label + " · " + continueTarget.title;
  }
}

$("#apps").addEventListener("click", function (e) {
  const b = e.target.closest(".appBtn");
  if (!b) return;
  appFilter = b.dataset.app;
  localStorage.setItem("queue.app", appFilter);
  renderApps();
  render();
});

$(".views").addEventListener("click", function (e) {
  const v = e.target.closest(".view");
  if (v) switchTab(v.dataset.tab);
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
  $("#send").disabled = true;
  try {
    const targetModel = continueTarget ? continueTarget.app : model;
    await fetch("api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        model: targetModel,
        session_id: continueTarget ? continueTarget.id : undefined,
      }),
    });
    promptEl.value = "";
    promptEl.style.height = "auto";
    continueTarget = null;
    updateTarget();
    await load();
    if (tab !== "tasks") switchTab("tasks");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    $("#send").disabled = false;
  }
});

$("#dashboard").addEventListener("click", async function (e) {
  const act = e.target.closest("[data-act]");
  if (!act) return;
  const action = act.dataset.act;
  const mod = act.dataset.model;
  if (action === "open") {
    return openApp(mod);
  }
  if (action === "quicknew") {
    model = mod;
    localStorage.setItem("queue.model", model);
    buildChips();
    $("#prompt").focus();
    $("#prompt").scrollIntoView({ behavior: "smooth" });
  }
});

$("#list").addEventListener("click", async function (e) {
  const act = e.target.closest("[data-act]");
  if (act) {
    e.stopPropagation();
    const id = act.dataset.id;
    if (act.dataset.act === "open") return openApp(act.dataset.model);
    if (act.dataset.act === "openapp") return openApp(act.dataset.app);
    if (act.dataset.act === "copy") {
      const t = tasks.find(function (x) { return x.id === id; });
      if (t) { await navigator.clipboard.writeText(t.output || ""); act.textContent = "Copied"; }
      return;
    }
    if (act.dataset.act === "showall") { showAll.add(id); renderTasks(); return; }
    if (act.dataset.act === "resume") {
      return startContinue(act.dataset.model, act.dataset.ref, "session " + act.dataset.ref.slice(0, 8));
    }
    if (act.dataset.act === "retry") await fetch("api/tasks/" + id + "/retry", { method: "POST" });
    if (act.dataset.act === "delete") { await fetch("api/tasks/" + id, { method: "DELETE" }); expanded.delete(id); }
    await load();
    return;
  }
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  renderTasks();
});

$("#sessions").addEventListener("click", function (e) {
  const act = e.target.closest("[data-act]");
  if (!act) return;
  if (act.dataset.act === "openapp") openApp(act.dataset.app);
  if (act.dataset.act === "continue") {
    startContinue(act.dataset.app, act.dataset.id, decodeURIComponent(act.dataset.title));
  }
});

$("#gear").onclick = async function () {
  const s = await (await fetch("api/settings")).json();
  $("#workdir").value = s.workdir || "";
  $("#queueThreshold").value = s.queue_min_remaining != null ? s.queue_min_remaining : 10;
  $("#sbUrl").value = s.supabase_url || "";
  $("#sbKey").value = "";
  $("#sbKey").placeholder = s.has_key ? "•••• saved" : "eyJhbGciOi…";
  $("#sheet").hidden = false;
};
$("#closeSheet").onclick = function () { $("#sheet").hidden = true; };
$("#sheet").onclick = function (e) { if (e.target.id === "sheet") $("#sheet").hidden = true; };
$("#saveSettings").onclick = async function () {
  const body = {
    workdir: $("#workdir").value,
    supabase_url: $("#sbUrl").value,
    queue_min_remaining: parseFloat($("#queueThreshold").value) || 10,
  };
  if ($("#sbKey").value.trim()) body.supabase_key = $("#sbKey").value.trim();
  await fetch("api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  queueMinRemaining = body.queue_min_remaining;
  $("#saveState").textContent = "Saved.";
  setTimeout(function () { $("#sheet").hidden = true; $("#saveState").textContent = ""; }, 700);
  load();
};

$("#clearTarget").onclick = function () { continueTarget = null; updateTarget(); };

renderApps();
buildChips();
updateTarget();
load();
setInterval(function () {
  if (!document.hidden) {
    load();
    if (tab === "sessions") loadSessions();
  }
}, 4000);
