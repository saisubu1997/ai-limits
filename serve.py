#!/usr/bin/env python3
"""Serve the AI Limits data to a phone on the same network.

  http://<host>.local:8787/t/<token>/          phone-friendly page
  http://<host>.local:8787/t/<token>/api.json  raw data (for Scriptable)
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
DATA_DIR = os.environ.get("AILIMITS_HOME") or os.path.join(HOME, ".limitswidget")
DATA = os.path.join(DATA_DIR, "data.json")
TOKEN_FILE = os.path.join(DATA_DIR, "web_token")
PORT = int(os.environ.get("AILIMITS_WEB_PORT") or 8787)
HERE = os.path.dirname(os.path.abspath(__file__))
FETCH = os.path.join(HERE, "fetch.py")


def read_token():
    try:
        token = open(TOKEN_FILE).read().strip()
        if token:
            return token
    except Exception:
        pass
    token = os.urandom(6).hex()
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(TOKEN_FILE, "w") as fh:
            fh.write(token)
        os.chmod(TOKEN_FILE, 0o600)
    except Exception:
        pass
    return token


TOKEN = read_token()
BASE = "/t/" + TOKEN + "/"


def ensure_fresh(max_age=150):
    try:
        age = time.time() - os.path.getmtime(DATA)
    except OSError:
        age = 1e9
    if age < max_age:
        return
    try:
        subprocess.run(["/usr/bin/python3", FETCH], timeout=45, capture_output=True)
    except Exception:
        pass


def load():
    try:
        with open(DATA) as fh:
            return json.load(fh)
    except Exception:
        return {"providers": [], "generated_at": None}


PAGE = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0b0b0f">
<title>AI Limits</title>
<style>
:root { color-scheme: dark; --card: rgba(255,255,255,.055); --line: rgba(255,255,255,.08); }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body {
  margin: 0; padding: max(18px, env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));
  background: radial-gradient(120% 80% at 80% 0%, #1b2340 0%, #0b0b0f 55%) fixed;
  color: #f2f2f7; font: 15px -apple-system, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
header { display: flex; align-items: baseline; justify-content: space-between; margin: 6px 2px 14px; }
.hright { display: flex; gap: 10px; align-items: baseline; }
.qlink { font-size: 12px; color: #8ea0ff; text-decoration: none; font-weight: 600; }
h1 { font-size: 26px; margin: 0; letter-spacing: -.02em; }
#updated { font-size: 12px; color: #8e8e93; font-variant-numeric: tabular-nums; }
.card { background: var(--card); border: .5px solid var(--line); border-radius: 18px;
  padding: 14px 14px 12px; margin-bottom: 10px; backdrop-filter: blur(20px); }
.row { display: flex; align-items: center; gap: 8px; }
.badge { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
  font-weight: 700; font-size: 13px; }
.name { font-weight: 600; font-size: 15px; }
.plan { font-size: 9px; font-weight: 700; letter-spacing: .04em; padding: 2px 6px; border-radius: 99px; }
.sub { font-size: 11px; color: #8e8e93; margin: 2px 0 0 34px; }
.status { margin-left: auto; font-size: 10px; font-weight: 600; padding: 3px 7px; border-radius: 99px;
  display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.dot { width: 5px; height: 5px; border-radius: 99px; background: currentColor; }
.metric { margin-top: 12px; }
.metric .top { display: flex; justify-content: space-between; align-items: baseline; }
.label { font-size: 12.5px; color: #b8b8c0; }
.value { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.track { height: 7px; border-radius: 99px; background: rgba(255,255,255,.09); margin-top: 6px; overflow: hidden; }
.fill { height: 100%; border-radius: 99px; }
.meta { font-size: 10.5px; color: #77777f; margin-top: 5px; }
footer { text-align: center; color: #63636b; font-size: 11px; margin-top: 18px; line-height: 1.5; }
</style>
</head><body>
<header><h1>Limits</h1><div class="hright"><span id="updated"></span><a class="qlink" href="queue/">Queue</a></div></header>
<div id="cards"></div>
<footer>Updates every 2 minutes from your Mac.<br>Add to Home Screen for a full-screen app.</footer>
<script>
const ACCENT = { claude: "#d97857", codex: "#1aa382", antigravity: "#528cf7", deepseek: "#5466f2" };
function level(r) { return r < 20 ? "#fa4a40" : r < 50 ? "#fa9e1f" : "#3dc761"; }
function esc(s) { return (s || "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function metric(m) {
  const hasBar = m.value_text == null;
  const pct = m.remaining_pct == null ? 0 : m.remaining_pct;
  const value = m.value_text != null ? esc(m.value_text) : Math.round(pct) + "% left";
  const colour = m.value_text != null ? "#f2f2f7" : level(pct);
  let tail = esc(m.sublabel || "");
  if (m.detail_text) tail += " · " + esc(m.detail_text);
  else if (m.reset_at) {
    const s = Math.round((new Date(m.reset_at) - Date.now()) / 1000);
    if (s > 0) {
      const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), mi = Math.floor(s%3600/60);
      tail += " · resets in " + (d ? d + "d " + h + "h" : h ? h + "h " + mi + "m" : mi + "m");
    }
  } else if (pct >= 99.5) tail += " · fresh window";
  return `<div class="metric"><div class="top"><span class="label">${esc(m.label)}</span>` +
    `<span class="value" style="color:${colour}">${value}</span></div>` +
    (hasBar ? `<div class="track"><div class="fill" style="width:${Math.max(3, pct)}%;` +
      `background:linear-gradient(90deg, ${level(pct)}bb, ${level(pct)})"></div></div>` : "") +
    `<div class="meta">${tail}</div></div>`;
}
function status(p) {
  const s = p.status || {};
  let text = "Not open", colour = "#8e8e93";
  if (s.state === "waiting") { text = "Needs you"; colour = "#ff9f0a"; }
  else if (s.running) {
    colour = "#3dc761";
    text = s.state === "working" ? "Working" : (s.sessions > 0 ? s.sessions + " active" : "Running");
  } else if (s.sessions > 0) { text = s.sessions + " recent"; }
  return `<span class="status" style="color:${colour};background:${colour}1f">` +
    `<span class="dot"></span>${text}</span>`;
}
function card(p) {
  const accent = ACCENT[p.id] || "#999";
  const plan = p.plan ? `<span class="plan" style="color:${accent};background:${accent}2b">` +
    `${esc(p.plan.toUpperCase())}</span>` : "";
  const session = (p.status || {}).session_name;
  const sub = session ? "▸ " + esc(session)
    : [p.vendor, p.account].filter(Boolean).map(esc).join(" · ");
  const metrics = p.ok ? (p.metrics || []).map(metric).join("") :
    `<div class="meta" style="margin-top:10px">${esc(p.error || "No data")}</div>`;
  return `<div class="card"><div class="row">` +
    `<div class="badge" style="color:${accent};background:${accent}2b">${esc(p.name[0])}</div>` +
    `<span class="name">${esc(p.name)}</span>${plan}${status(p)}</div>` +
    `<div class="sub">${sub}</div>${metrics}</div>`;
}
function render(d) {
  document.getElementById("cards").innerHTML = (d.providers || []).map(card).join("");
  const t = d.generated_at ? new Date(d.generated_at) : new Date();
  document.getElementById("updated").textContent = t.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
}
async function refresh() {
  try {
    const r = await fetch("api.json", { cache: "no-store" });
    render(await r.json());
  } catch (e) {}
}
refresh();
setInterval(refresh, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
</script>
</body></html>
"""


QUEUE_PORT = int(os.environ.get("AILIMITS_QUEUE_PORT") or 8790)


class Handler(BaseHTTPRequestHandler):
    server_version = "AILimitsWeb/1.0"

    def _proxy_queue(self, method):
        """Forward /t/<token>/queue/* to the work-queue service."""
        import http.client
        split = urllib.parse.urlsplit(self.path)
        prefix = BASE + "queue"
        if not split.path.startswith(prefix):
            return False
        target = "/t/" + TOKEN + "/" + split.path[len(prefix):].lstrip("/")
        if split.query:
            target += "?" + split.query
        body = b""
        if method in ("POST", "PATCH"):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        headers = {}
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        try:
            conn = http.client.HTTPConnection("127.0.0.1", QUEUE_PORT, timeout=120)
            conn.request(method, target, body=body, headers=headers)
            resp = conn.getresponse()
            payload = resp.read()
        except Exception:
            self._send(502, json.dumps({"error": "queue service is not running"}))
            return True
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.getheader("Content-Type") or "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)
        return True

    def do_POST(self):
        if self._proxy_queue("POST"):
            return
        self._send(404, json.dumps({"error": "not found"}))

    def do_DELETE(self):
        if self._proxy_queue("DELETE"):
            return
        self._send(404, json.dumps({"error": "not found"}))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, content_type):
        payload = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self._proxy_queue("GET"):
            return
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", BASE)
            self.end_headers()
            return
        if path == BASE + "api.json":
            ensure_fresh()
            self._send(200, json.dumps(load()), "application/json")
            return
        if path in (BASE, BASE + "index.html"):
            ensure_fresh()
            self._send(200, PAGE, "text/html")
            return
        self._send(404, "not found", "text/plain")


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("AILimits web on http://<this-mac>.local:%d%s" % (PORT, BASE), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
