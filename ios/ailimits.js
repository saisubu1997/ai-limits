// AI Limits - Scriptable widget
// Paste into a new Scriptable script, then add a Medium widget.
// Replace the URL below with the one printed by install.sh (contains your token).

const ENDPOINT = "http://YOUR-MAC.local:8787/t/REPLACE_WITH_TOKEN/api.json";

const ACCENT = {
  claude: "#d97857", codex: "#1aa382", antigravity: "#528cf7", deepseek: "#5466f2",
};

function level(pct) {
  if (pct == null) return new Color("#f2f2f7");
  if (pct < 20) return new Color("#fa4a40");
  if (pct < 50) return new Color("#fa9e1f");
  return new Color("#3dc761");
}

function addText(stack, text, size, colour, weight) {
  const t = stack.addText(text);
  t.font = weight === "bold"
    ? Font.semiboldSystemFont(size)
    : Font.systemFont(size);
  t.textColor = colour || Color.white();
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

async function build() {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#111114");
  widget.setPadding(12, 14, 12, 14);

  let data = null;
  try {
    const req = new Request(ENDPOINT + "?t=" + Date.now());
    req.timeoutInterval = 15;
    data = await req.loadJSON();
  } catch (e) {}

  const head = widget.addStack();
  head.centerAlignContent();
  addText(head, "Limits", 14, Color.white(), "bold");
  head.addSpacer();
  if (data && data.generated_at) {
    const d = new Date(data.generated_at);
    addText(head, d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), 9,
            new Color("#8e8e93"));
  }
  widget.addSpacer(8);

  if (!data || !data.providers) {
    addText(widget, "Cannot reach the Mac", 11, new Color("#fa9e1f"));
    widget.addSpacer(4);
    addText(widget, "Same Wi-Fi and Mac awake?", 9, new Color("#8e8e93"));
    return widget;
  }

  for (const p of data.providers) {
    const row = widget.addStack();
    row.centerAlignContent();
    row.spacing = 5;

    const dot = row.addText("●");
    dot.font = Font.systemFont(7);
    dot.textColor = new Color(ACCENT[p.id] || "#999999");

    addText(row, p.name, 11, Color.white(), "bold");
    row.addSpacer();

    const s = p.status || {};
    if (s.state === "waiting") {
      addText(row, "needs you", 9, new Color("#ff9f0a"), "bold");
    } else if (p.ok && p.metrics && p.metrics.length) {
      const m = p.metrics[0];
      if (m.value_text) {
        addText(row, m.value_text, 11, Color.white(), "bold");
      } else {
        addText(row, Math.round(m.remaining_pct) + "%", 11, level(m.remaining_pct), "bold");
        if (p.metrics[1] && p.metrics[1].remaining_pct != null) {
          addText(row, "·", 9, new Color("#63636b"));
          addText(row, Math.round(p.metrics[1].remaining_pct) + "%", 11,
                  level(p.metrics[1].remaining_pct), "bold");
        }
      }
    } else {
      addText(row, "—", 11, new Color("#63636b"));
    }
    widget.addSpacer(6);
  }

  widget.addSpacer();
  addText(widget, "5h session · weekly", 8, new Color("#63636b"));
  return widget;
}

const widget = await build();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
