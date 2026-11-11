#!/usr/bin/env python3
"""AI Limits work queue - local task runner + PWA backend.

Tasks are stored in SQLite, executed by the bundled Claude/Codex CLIs, and
streamed back to the PWA. Optional Supabase mirroring is configured from the UI.
"""

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
DATA_DIR = os.environ.get("AILIMITS_HOME") or os.path.join(HOME, ".limitswidget")
DB_PATH = os.path.join(DATA_DIR, "queue.db")
TOKEN_FILE = os.path.join(DATA_DIR, "web_token")
PORT = int(os.environ.get("AILIMITS_QUEUE_PORT") or 8790)
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

CLAUDE_BIN = os.path.join(
    HOME, "Library/Application Support/Claude/claude-code")
CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"

MODELS = {
    "claude": {"label": "Claude", "runnable": True},
    "codex": {"label": "Codex", "runnable": True},
    "antigravity": {"label": "Antigravity", "runnable": False},
    "deepseek": {"label": "DeepSeek", "runnable": False},
}

# How to bring the matching Mac app forward.
APPS = {
    "claude": ("com.anthropic.claudefordesktop", "/Applications/Claude.app"),
    "codex": ("com.openai.codex", "/Applications/ChatGPT.app"),
    "antigravity": ("com.google.antigravity", "/Applications/Antigravity.app"),
    "deepseek": ("com.deepseek.dsh", "/Applications/DeepSeek Harness.app"),
}


def open_app(model):
    bundle, path = APPS.get(model, (None, None))
    if bundle:
        done = subprocess.run(["open", "-b", bundle], capture_output=True)
        if done.returncode == 0:
            return True
    if path and os.path.exists(path):
        return subprocess.run(["open", path], capture_output=True).returncode == 0
    return False


def token():
    try:
        value = open(TOKEN_FILE).read().strip()
        if value:
            return value
    except Exception:
        pass
    value = os.urandom(6).hex()
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(TOKEN_FILE, "w") as fh:
        fh.write(value)
    os.chmod(TOKEN_FILE, 0o600)
    return value


TOKEN = token()
BASE = "/t/" + TOKEN + "/"


def db():
    os.makedirs(DATA_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("""CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT, prompt TEXT, model TEXT,
        status TEXT, output TEXT, exit_code INTEGER, session_ref TEXT,
        created_at REAL, updated_at REAL, remote_id TEXT)""")
    con.execute("""CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT)""")
    try:
        con.execute("ALTER TABLE tasks ADD COLUMN resume_id TEXT")
    except Exception:
        pass
    return con


def get_setting(key, default=None):
    con = db()
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    con.close()
    return row["value"] if row else default


def set_setting(key, value):
    con = db()
    con.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?",
                (key, value, value))
    con.commit()
    con.close()


def claude_binary():
    root = CLAUDE_BIN
    if not os.path.isdir(root):
        return None
    best = None
    for version in sorted(os.listdir(root)):
        vdir = os.path.join(root, version)
        if not os.path.isdir(vdir):
            continue
        for hashdir in os.listdir(vdir):
            candidate = os.path.join(vdir, hashdir, "claude.app/Contents/MacOS/claude")
            if os.path.exists(candidate):
                best = candidate
    return best


def claude_token():
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, here)
        sys.path.insert(0, os.path.dirname(here))   # fetch.py sits next to queue/
        import fetch as f
        cfg = json.load(open(os.path.join(HOME, "Library/Application Support/Claude/config.json")))
        key = f.claude_aes_key()
        if not key:
            return None
        cache = json.loads(f.electron_decrypt(cfg["oauth:tokenCacheV2"], key))
        for k, v in cache.items():
            if isinstance(v, dict) and v.get("token") and "user:profile" in k:
                return v["token"]
    except Exception:
        return None
    return None


def newest_session(kind):
    patterns = {"claude": os.path.join(HOME, ".claude/projects/*/*.jsonl"),
                "codex": os.path.join(HOME, ".codex/sessions/**/*.jsonl")}
    import glob
    files = glob.glob(patterns[kind], recursive=True)
    return max(files, key=os.path.getmtime) if files else None



# ---------------------------------------------------------------- sessions

def norm_time(ts):
    return float(ts or 0)


def claude_sessions(limit=12):
    import glob
    files = sorted(glob.glob(os.path.join(HOME, '.claude/projects/*/*.jsonl')),
                   key=os.path.getmtime, reverse=True)[:limit]
    out = []
    for path in files:
        title = None
        try:
            size = os.path.getsize(path)
            with open(path, 'rb') as fh:
                fh.seek(max(0, size - 40000))
                tail = fh.read().decode('utf-8', 'replace')
            for line in reversed(tail.splitlines()):
                if '"lastPrompt"' in line:
                    rec = json.loads(line)
                    title = (rec.get('lastPrompt') or '').strip()[:70]
                    break
        except Exception:
            pass
        out.append({'id': os.path.basename(path)[:-6], 'app': 'claude',
                    'title': title or 'Claude session',
                    'updated_at': os.path.getmtime(path)})
    return out


def codex_sessions(limit=12):
    import glob
    names = {}
    try:
        with open(os.path.join(HOME, '.codex/session_index.jsonl')) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                names[rec.get('id')] = rec.get('thread_name')
    except Exception:
        pass
    files = sorted(glob.glob(os.path.join(HOME, '.codex/sessions/**/*.jsonl'), recursive=True),
                   key=os.path.getmtime, reverse=True)[:limit]
    out = []
    import re as _re
    for path in files:
        m = _re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
                      os.path.basename(path))
        if not m:
            continue
        sid = m.group(1)
        title = names.get(sid)
        if not title:
            title = first_codex_prompt(path)
        out.append({'id': sid, 'app': 'codex',
                    'title': title or 'Codex thread',
                    'updated_at': os.path.getmtime(path)})
    return out


def first_codex_prompt(path):
    """Fallback title: the first user message in the rollout."""
    try:
        with open(path, errors='replace') as fh:
            for _ in range(400):
                line = fh.readline()
                if not line:
                    break
                if 'user_message' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                payload = rec.get('payload') or {}
                text = payload.get('message') or payload.get('text') or ''
                text = ' '.join(str(text).split())
                if text:
                    return text[:70]
    except Exception:
        pass
    return None


def deepseek_sessions(limit=8):
    import glob
    dirs = sorted(glob.glob(os.path.join(HOME, '.dsh/sessions/*/session-*')),
                  key=os.path.getmtime, reverse=True)[:limit]
    out = []
    for path in dirs:
        title = None
        try:
            sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            import fetch as f
            title = f.deepseek_session_title(path)
        except Exception:
            title = None
        out.append({'id': os.path.basename(path).replace('session-', ''), 'app': 'deepseek',
                    'title': title or 'DeepSeek session',
                    'updated_at': os.path.getmtime(path)})
    return out


def all_sessions():
    groups = {'claude': [], 'codex': [], 'deepseek': [], 'antigravity': []}
    for name, fn in (('claude', claude_sessions), ('codex', codex_sessions),
                     ('deepseek', deepseek_sessions)):
        try:
            groups[name] = fn()
        except Exception:
            groups[name] = []
    return groups

def run_task(task_id):
    con = db()
    task = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    con.close()
    if not task:
        return

    model = task["model"]
    meta = MODELS.get(model, {})
    if not meta.get("runnable"):
        update(task_id, status="manual", exit_code=None,
               output_append="This app has no headless CLI, so the widget cannot start it.\n"
               "Open %s and paste the task there." % meta.get("label", model))
        return

    before = newest_session(model)
    update(task_id, status="running", output_append=None)

    env = dict(os.environ)
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:" + env.get("PATH", "")
    if model == "claude":
        binary = claude_binary()
        token = claude_token()
        if not binary:
            update(task_id, status="failed", exit_code=-1,
                   output_append="Claude Code CLI not found - open Claude Desktop once so it installs its CLI.")
            return
        if not token:
            update(task_id, status="failed", exit_code=-1,
                   output_append="No Claude token: sign in to Claude Desktop, then restart the widget.")
            return
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
        cmd = [binary, "-p", task["prompt"], "--output-format", "text"]
        resume_id = task["resume_id"] if "resume_id" in task.keys() else None
        if resume_id:
            cmd += ["--resume", resume_id]
    else:
        if not os.path.exists(CODEX_BIN):
            update(task_id, status="failed", exit_code=-1,
                   output_append="Codex CLI not found at %s" % CODEX_BIN)
            return
        resume_id = task["resume_id"] if "resume_id" in task.keys() else None
        if resume_id:
            cmd = [CODEX_BIN, "exec", "--skip-git-repo-check", "resume", resume_id, task["prompt"]]
        else:
            cmd = [CODEX_BIN, "exec", "--skip-git-repo-check", task["prompt"]]

    cwd = get_setting("workdir") or HOME
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
    except Exception as exc:
        update(task_id, status="failed", exit_code=-1, output_append=str(exc))
        return

    started = time.time()
    buffer = []
    for line in proc.stdout:
        buffer.append(line)
        if len(buffer) >= 8 or time.time() - started > 1.5:
            update(task_id, output_append="".join(buffer))
            buffer = []
            started = time.time()
    proc.wait()
    if buffer:
        update(task_id, output_append="".join(buffer))

    after = newest_session(model)
    ref = os.path.basename(after) if after and after != before else None
    update(task_id,
           status="done" if proc.returncode == 0 else "failed",
           exit_code=proc.returncode, session_ref=ref)


def update(task_id, status=None, exit_code=None, output_append=None, session_ref=None):
    con = db()
    fields = ["updated_at=?"]
    values = [time.time()]
    if status is not None:
        fields.append("status=?")
        values.append(status)
    if exit_code is not None:
        fields.append("exit_code=?")
        values.append(exit_code)
    if session_ref is not None:
        fields.append("session_ref=?")
        values.append(session_ref)
    if output_append:
        fields.append("output=COALESCE(output,'') || ?")
        values.append(output_append)
    values.append(task_id)
    con.execute("UPDATE tasks SET %s WHERE id=?" % ", ".join(fields), values)
    con.commit()
    row = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    con.close()
    if row:
        push_to_supabase(row)


WORKER = threading.Lock()


def enqueue(task_id):
    def job():
        with WORKER:
            run_task(task_id)
    threading.Thread(target=job, daemon=True).start()

# ---------------------------------------------------------------- Supabase

def supabase_configured():
    return bool(get_setting("supabase_url") and get_setting("supabase_key"))


def supabase_request(method, path, body=None):
    url = get_setting("supabase_url").rstrip("/") + path
    key = get_setting("supabase_key")
    headers = {"apikey": key, "Authorization": "Bearer " + key,
               "Content-Type": "application/json"}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode() or "[]"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        return e.code, []
    except Exception:
        return 0, []


FIELDS = ("id", "title", "prompt", "model", "status", "output",
          "exit_code", "session_ref", "created_at", "updated_at")


def push_to_supabase(task):
    if not supabase_configured():
        return
    row = {k: task[k] for k in FIELDS}
    supabase_request("POST", "/rest/v1/tasks?on_conflict=id", row)


def pull_from_supabase():
    if not supabase_configured():
        return
    status, rows = supabase_request("GET", "/rest/v1/tasks?select=*&limit=100")
    if status != 200 or not isinstance(rows, list):
        return
    con = db()
    local = {r["id"] for r in con.execute("SELECT id FROM tasks").fetchall()}
    fresh = []
    for row in rows:
        tid = row.get("id")
        if not tid or tid in local:
            continue
        if (row.get("action") or "run") == "open":
            # A command from the hosted app: bring an app forward, no prompt.
            ok = open_app(row.get("model") or "")
            con.execute(
                "INSERT INTO tasks(id,title,prompt,model,status,output,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (tid, "Open " + str(row.get("model")), "", row.get("model") or "",
                 "done" if ok else "failed", "opened" if ok else "app not found",
                 row.get("created_at") or time.time(), time.time()))
            con.commit()
            local.add(tid)
            con2 = db()
            saved = con2.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
            con2.close()
            if saved:
                push_to_supabase(saved)
            continue
        con.execute(
            "INSERT INTO tasks(id,title,prompt,model,status,output,exit_code,"
            "session_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (tid, row.get("title") or "", row.get("prompt") or "",
             row.get("model") or "codex", row.get("status") or "queued",
             row.get("output") or "", row.get("exit_code"),
             row.get("session_ref"), row.get("created_at") or time.time(),
             row.get("updated_at") or time.time()))
        local.add(tid)
        fresh.append(tid)
    con.commit()
    con.close()
    for tid in fresh:
        con = db()
        row = con.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()
        con.close()
        if row and row["status"] == "queued":
            enqueue(tid)


def sync_loop():
    while True:
        try:
            pull_from_supabase()
        except Exception:
            pass
        time.sleep(8)



def task_json(row):
    return {k: row[k] for k in row.keys()}


PAGE_FILES = {"", "index.html", "app.js", "styles.css", "manifest.webmanifest",
              "sw.js", "icon-192.png", "icon-512.png"}


class Handler(BaseHTTPRequestHandler):
    server_version = "AILimitsQueue/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype="application/json", cache="no-store"):
        payload = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", BASE)
            self.end_headers()
            return
        if not path.startswith(BASE):
            return self._send(404, json.dumps({"error": "not found"}))
        rest = path[len(BASE):]

        if rest == "api/tasks":
            con = db()
            rows = con.execute("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200").fetchall()
            con.close()
            return self._send(200, json.dumps({"tasks": [task_json(r) for r in rows]}))
        if rest == "api/sessions":
            return self._send(200, json.dumps({
                "sessions": all_sessions(),
                "can_resume": {"claude": True, "codex": True,
                               "deepseek": False, "antigravity": False}}))
        if rest == "api/settings":
            return self._send(200, json.dumps({
                "supabase_url": get_setting("supabase_url", ""),
                "has_key": bool(get_setting("supabase_key")),
                "workdir": get_setting("workdir", HOME),
            }))
        if rest.startswith("api/tasks/"):
            tid = rest.split("/")[2]
            con = db()
            row = con.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
            con.close()
            if not row:
                return self._send(404, json.dumps({"error": "missing"}))
            return self._send(200, json.dumps(task_json(row)))

        name = "index.html" if rest in ("", "/") else rest
        if name not in PAGE_FILES:
            return self._send(404, json.dumps({"error": "not found"}))
        file_path = os.path.join(WEB_DIR, name)
        if not os.path.exists(file_path):
            return self._send(404, json.dumps({"error": "missing " + name}))
        ctype = {"html": "text/html", "js": "application/javascript", "css": "text/css",
                 "webmanifest": "application/manifest+json", "png": "image/png"}.get(
            name.rsplit(".", 1)[-1], "application/octet-stream")
        with open(file_path, "rb") as fh:
            body = fh.read()
        self._send(200, body, ctype + ("; charset=utf-8" if ctype.startswith("text") or "javascript" in ctype or "json" in ctype else ""))

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith(BASE):
            return self._send(404, json.dumps({"error": "not found"}))
        rest = path[len(BASE):]
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            body = {}

        if rest == "api/tasks":
            prompt = (body.get("prompt") or "").strip()
            if not prompt:
                return self._send(400, json.dumps({"error": "prompt required"}))
            model = body.get("model") or "codex"
            if model not in MODELS:
                return self._send(400, json.dumps({"error": "unknown model"}))
            tid = "t_" + os.urandom(6).hex()
            title = (body.get("title") or prompt.splitlines()[0])[:90]
            now = time.time()
            con = db()
            resume_id = (body.get("session_id") or "").strip() or None
            con.execute("INSERT INTO tasks(id,title,prompt,model,status,output,created_at,updated_at,resume_id) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (tid, title, prompt, model, "queued", "", now, now, resume_id))
            con.commit()
            con.close()
            enqueue(tid)
            return self._send(200, json.dumps({"id": tid}))

        if rest == "api/settings":
            for key in ("supabase_url", "supabase_key", "workdir"):
                if key in body:
                    set_setting(key, (body.get(key) or "").strip())
            return self._send(200, json.dumps({"ok": True}))

        if rest == "api/open":
            model = body.get("model") or ""
            ok = open_app(model) if model in APPS else False
            return self._send(200 if ok else 502, json.dumps({"ok": ok, "model": model}))

        if rest.startswith("api/tasks/") and rest.endswith("/retry"):
            tid = rest.split("/")[2]
            con = db()
            con.execute("UPDATE tasks SET status='queued', output='', exit_code=NULL, updated_at=? WHERE id=?",
                        (time.time(), tid))
            con.commit()
            con.close()
            enqueue(tid)
            return self._send(200, json.dumps({"ok": True}))

        return self._send(404, json.dumps({"error": "not found"}))

    def do_DELETE(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith(BASE + "api/tasks/"):
            tid = path.split("/")[3]
            con = db()
            con.execute("DELETE FROM tasks WHERE id=?", (tid,))
            con.commit()
            con.close()
            return self._send(200, json.dumps({"ok": True}))
        return self._send(404, json.dumps({"error": "not found"}))


def main():
    db().close()
    threading.Thread(target=sync_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("AI Limits queue on http://<this-mac>.local:%d%s" % (PORT, BASE), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
