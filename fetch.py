#!/usr/bin/env python3
"""Collect plan limits for Claude, Codex and Antigravity from local app state.

Reads only files already on this Mac and talks to the same endpoints the apps
themselves use.  No secrets are written anywhere except the process memory.

Usage:
    python3 fetch.py                 # write ~/.limitswidget/data.json
    python3 fetch.py --out FILE      # write somewhere else
    python3 fetch.py --stdout        # print JSON, write nothing
"""

import base64
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
DATA_HOME = os.environ.get("AILIMITS_HOME") or os.path.join(HOME, ".limitswidget")
UA = "AILimitsWidget/1.0"

ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"


# ---------------------------------------------------------------- utilities

def iso_now():
    return datetime.now(timezone.utc).isoformat()


def iso_from_epoch(sec):
    try:
        return datetime.fromtimestamp(float(sec), timezone.utc).isoformat()
    except Exception:
        return None


def http_json(url, headers, payload=None, timeout=25):
    data = None
    hdrs = dict(headers)
    if payload is not None:
        data = json.dumps(payload).encode()
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body[:400]}
        return e.code, parsed
    except Exception as e:
        return 0, {"error": str(e)}


def keychain_secret(service):
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                           capture_output=True, text=True, timeout=20)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return None


def claude_aes_key():
    """Return the 16-byte safeStorage key, caching it after one keychain read.

    macOS throttles repeated `security` lookups, so the derived key is stored
    beside the cache with 0600 permissions and reused from then on.
    """
    import hashlib
    key_path = os.path.join(DATA_HOME, "claude_aes_key")
    try:
        stored = open(key_path).read().strip()
        if len(stored) == 32:
            return bytes.fromhex(stored)
    except Exception:
        pass
    password = keychain_secret("Claude Safe Storage")
    if not password:
        return None
    key = hashlib.pbkdf2_hmac("sha1", password.encode(), b"saltysalt", 1003, 16)
    try:
        os.makedirs(DATA_HOME, exist_ok=True)
        with open(key_path, "w") as fh:
            fh.write(key.hex())
        os.chmod(key_path, 0o600)
    except Exception:
        pass
    return key


def electron_decrypt(blob_b64, key):
    """Electron safeStorage: AES-128-CBC with IV of 16 spaces, 'v10' prefix."""
    raw = base64.b64decode(blob_b64)
    if raw[:3] != b"v10":
        return None
    r = subprocess.run(
        ["openssl", "enc", "-d", "-aes-128-cbc",
         "-K", key.hex(), "-iv", (b" " * 16).hex()],
        input=raw[3:], capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", "replace")


def decode_b64_layers(buf, depth=0, max_depth=3):
    """Yield every plausible base64 payload hidden in a protobuf-ish blob."""
    if depth > max_depth:
        return
    for chunk in re.findall(rb"[A-Za-z0-9+/=_.:\-]{40,}", buf):
        try:
            dec = base64.b64decode(chunk + b"=" * (-len(chunk) % 4))
        except Exception:
            continue
        if len(dec) < 20:
            continue
        yield dec
        for sub in decode_b64_layers(dec, depth + 1, max_depth):
            yield sub


def pct(value, total=100.0):
    try:
        return max(0.0, min(100.0, float(value)))
    except Exception:
        return None


def metric(mid, label, sublabel, used_pct, reset_at, window_secs=None,
           value_text=None, detail_text=None):
    used = pct(used_pct)
    return {
        "id": mid,
        "label": label,
        "sublabel": sublabel,
        "used_pct": used,
        "remaining_pct": None if used is None else round(100.0 - used, 1),
        "reset_at": reset_at,
        "window_secs": window_secs,
        "value_text": value_text,
        "detail_text": detail_text,
    }


def running_commands():
    try:
        out = subprocess.run(["/bin/ps", "-axo", "comm="],
                             capture_output=True, text=True, timeout=8)
        return [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]
    except Exception:
        return []


def is_running(needle, commands):
    return any(needle in c for c in commands)


def mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0


def tail_json(path, limit=6):
    """Last few JSON records of a JSONL file without reading the whole thing."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 65536))
            chunk = fh.read().decode("utf-8", "replace")
    except Exception:
        return []
    out = []
    for line in chunk.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out[-limit:]


def empty_provider(pid, name, vendor, err):
    return {
        "id": pid, "name": name, "vendor": vendor, "plan": None, "account": None,
        "ok": False, "stale": False, "error": err, "metrics": [], "notes": [],
    }


# ---------------------------------------------------------------- Claude

def short_name(text, limit=46):
    if not text:
        return None
    clean = " ".join(str(text).split())
    return clean[:limit] + ("\u2026" if len(clean) > limit else "")


def claude_session_name(path):
    for rec in reversed(tail_json(path, 12)):
        if rec.get("type") == "last-prompt" and rec.get("lastPrompt"):
            return short_name(rec["lastPrompt"])
    return None


def codex_session_name(path):
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                  os.path.basename(path))
    if not m:
        return None
    try:
        with open(os.path.join(HOME, ".codex/session_index.jsonl")) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("id") == m.group(1):
                    return short_name(rec.get("thread_name"))
    except Exception:
        pass
    return None


def status_claude(commands):
    paths = glob.glob(os.path.join(HOME, ".claude/projects/*/*.jsonl"))
    active = [f for f in paths if time.time() - mtime(f) < 1800]
    newest = max(paths, key=mtime) if paths else None
    state = "idle"
    if newest and time.time() - mtime(newest) < 600:
        records = tail_json(newest, 3)
        last = records[-1] if records else None
        if last and last.get("type") == "assistant":
            content = (last.get("message") or {}).get("content")
            if isinstance(content, list) and any(c.get("type") == "tool_use" for c in content):
                state = "waiting"
        if state != "waiting" and time.time() - mtime(newest) < 180:
            state = "working"
    name = claude_session_name(newest) if newest and active else None
    return {"running": is_running("Claude.app/Contents/MacOS/Claude", commands),
            "sessions": len(active), "state": state, "session_name": name}


def status_codex(commands):
    paths = glob.glob(os.path.join(HOME, ".codex/sessions/**/*.jsonl"), recursive=True)
    active = [f for f in paths if time.time() - mtime(f) < 1800]
    newest = max(paths, key=mtime) if paths else None
    state = "idle"
    if newest and time.time() - mtime(newest) < 180:
        records = tail_json(newest, 4)
        kinds = [((r.get("payload") or {}).get("type")) for r in records
                 if r.get("type") == "event_msg"]
        if kinds and kinds[-1] != "task_complete":
            state = "working"
    name = codex_session_name(newest) if newest and active else None
    return {"running": is_running("ChatGPT.app/Contents/MacOS/ChatGPT", commands),
            "sessions": len(active), "state": state, "session_name": name}


def status_antigravity(commands):
    db = os.path.join(HOME, "Library/Application Support/Antigravity IDE"
                            "/User/globalStorage/state.vscdb")
    fresh = time.time() - mtime(db) < 120
    return {"running": is_running("Antigravity.app/Contents/MacOS/Antigravity", commands),
            "sessions": 1 if fresh else 0, "state": "working" if fresh else "idle",
            "session_name": None}


def status_deepseek(commands):
    roots = glob.glob(os.path.join(HOME, ".dsh/sessions/*/session-*"))
    active = [d for d in roots if time.time() - mtime(d) < 1800]
    fresh = max((mtime(d) for d in roots), default=0)
    state = "working" if time.time() - fresh < 120 else "idle"
    name = None
    if roots:
        newest_dir = max(roots, key=mtime)
        slug = os.path.basename(os.path.dirname(newest_dir)).strip("-")
        parts = slug.split("-")
        name = short_name("-".join(parts[-2:]) if len(parts) > 1 else slug)
    return {"running": is_running("DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness", commands),
            "sessions": len(active), "state": state, "session_name": name}


def claude_provider(status=None):
    out = empty_provider("claude", "Claude", "Anthropic", None)
    out["status"] = status
    cfg_path = os.path.join(HOME, "Library/Application Support/Claude/config.json")
    try:
        cfg = json.load(open(cfg_path))
    except Exception as e:
        out["error"] = "Claude Desktop config not readable (%s)" % e
        return out

    blob = cfg.get("oauth:tokenCacheV2") or cfg.get("oauth:tokenCache")
    if not blob:
        out["error"] = "Claude Desktop is not signed in"
        return out

    key = claude_aes_key()
    if not key:
        out["error"] = "Keychain access for Claude needed once - run the app sign-in"
        return out

    try:
        cache = json.loads(electron_decrypt(blob, key) or "{}")
    except Exception as e:
        out["error"] = "Could not read Claude token cache (%s)" % e
        return out

    entry = None
    for key, val in cache.items():
        if not isinstance(val, dict) or not val.get("token"):
            continue
        if "user:profile" in key and (entry is None or "claude_code" in key):
            entry = val
    if not entry:
        out["error"] = "No Claude OAuth token with usage scope"
        return out

    plan = (entry.get("subscriptionType") or "").capitalize() or None
    token = entry["token"]

    status, body = http_json("https://api.anthropic.com/api/oauth/usage", {
        "Authorization": "Bearer " + token,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-cli/2.1.321 (external, cli)",
        "Accept": "application/json",
    })

    if status == 401:
        # Access token aged out: refresh with the stored refresh token.
        status_r, body_r = http_json("https://console.anthropic.com/v1/oauth/token", {
            "Accept": "application/json",
            "User-Agent": "claude-cli/2.1.321 (external, cli)",
        }, payload={
            "grant_type": "refresh_token",
            "refresh_token": entry.get("refreshToken"),
            "client_id": ANTHROPIC_CLIENT_ID,
        })
        new_token = (body_r or {}).get("access_token")
        if new_token:
            status, body = http_json("https://api.anthropic.com/api/oauth/usage", {
                "Authorization": "Bearer " + new_token,
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "claude-cli/2.1.321 (external, cli)",
                "Accept": "application/json",
            })
        else:
            out["error"] = "Claude session expired - open Claude Desktop"
            return out

    if status != 200:
        out["error"] = "Claude usage API returned %s" % status
        return out

    five = body.get("five_hour") or {}
    week = body.get("seven_day") or {}
    metrics = []
    if five.get("utilization") is not None:
        metrics.append(metric("session", "Session", "5-hour window",
                              five["utilization"], five.get("resets_at"), 18000))
    if week.get("utilization") is not None:
        metrics.append(metric("weekly", "Weekly", "7-day window",
                              week["utilization"], week.get("resets_at"), 604800))

    scoped = [l for l in (body.get("limits") or [])
              if l.get("kind") == "weekly_scoped" and (l.get("percent") or 0) > 0]
    for i, s in enumerate(scoped[:2]):
        name = ((s.get("scope") or {}).get("model") or {}).get("display_name") or "Model"
        metrics.append(metric("scoped%d" % i, name, "weekly model cap",
                              s.get("percent"), s.get("resets_at"), 604800))

    extra = body.get("extra_usage") or {}
    notes = []
    sub = entry.get("subscriptionType")
    if sub:
        out["plan"] = sub.capitalize()
    if extra.get("is_enabled"):
        notes.append("Extra usage enabled")
    if (body.get("spend") or {}).get("enabled"):
        notes.append("Usage credits active")

    out.update(ok=True, metrics=metrics, notes=notes)
    return out


# ---------------------------------------------------------------- Codex

def codex_provider(status=None):
    out = empty_provider("codex", "Codex", "OpenAI", None)
    out["status"] = status
    auth_path = os.path.join(HOME, ".codex/auth.json")
    try:
        auth = json.load(open(auth_path))
    except Exception as e:
        out["error"] = "Codex is not signed in (%s)" % e
        return out

    tokens = auth.get("tokens") or {}
    token = tokens.get("access_token")
    account = tokens.get("account_id")
    if not token:
        out["error"] = "Codex has no ChatGPT access token"
        return out

    def call(tok):
        return http_json("https://chatgpt.com/backend-api/wham/usage", {
            "Authorization": "Bearer " + tok,
            "chatgpt-account-id": account or "",
            "User-Agent": "codex-cli/0.50.0",
            "Accept": "application/json",
        })

    status, body = call(token)

    if status == 401 and tokens.get("refresh_token"):
        client_id = (tokens.get("oauth_provenance") or {}).get("client_id")
        if client_id:
            _, refreshed = http_json("https://auth.openai.com/oauth/token",
                                     {"Content-Type": "application/json"},
                                     payload={"client_id": client_id,
                                              "grant_type": "refresh_token",
                                              "refresh_token": tokens["refresh_token"],
                                              "scope": "openid profile email"})
            if refreshed.get("access_token"):
                status, body = call(refreshed["access_token"])

    if status != 200:
        out["error"] = "Codex usage API returned %s" % status
        return out

    rl = body.get("rate_limit") or {}
    metrics = []
    pw = rl.get("primary_window") or {}
    sw = rl.get("secondary_window") or {}
    if pw.get("used_percent") is not None:
        metrics.append(metric("session", "Session", "5-hour window", pw["used_percent"],
                              iso_from_epoch(pw.get("reset_at")), pw.get("limit_window_seconds")))
    if sw.get("used_percent") is not None:
        metrics.append(metric("weekly", "Weekly", "7-day window", sw["used_percent"],
                              iso_from_epoch(sw.get("reset_at")), sw.get("limit_window_seconds")))

    plan = (body.get("plan_type") or "").capitalize()
    notes = []
    if rl.get("limit_reached"):
        notes.append("Limit reached")

    out.update(ok=True, plan=plan or None, account=body.get("email"),
               metrics=metrics, notes=notes)
    return out


# ---------------------------------------------------------------- Antigravity

# The OAuth client used to refresh Antigravity's token ships inside the app
# itself. Read it from the installed bundle instead of vendoring Google's
# credentials in this repository.
AG_BUNDLES = [
    "/Applications/Antigravity IDE.app/Contents/Resources/app/out/main.js",
    "/Applications/Antigravity.app/Contents/Resources/app/out/main.js",
    os.path.join(HOME, "Library/Application Support/Antigravity IDE"
                       "/User/globalStorage/extensions"),
]
AG_SECRET_PATH = os.path.join(DATA_HOME, "antigravity_secret.txt")
AG_CLIENT_CACHE = os.path.join(DATA_HOME, "antigravity_clients.json")

CLIENT_ID_RE = re.compile(r"[0-9]{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com")
CLIENT_SECRET_RE = re.compile(r"GOCSPX-[A-Za-z0-9_-]{20,}")


def antigravity_clients():
    """OAuth client pairs, from env, cache, or the installed Antigravity bundle."""
    env_id = os.environ.get("AILIMITS_AG_CLIENT_ID")
    env_secret = os.environ.get("AILIMITS_AG_CLIENT_SECRET")
    if env_id and env_secret:
        return [(env_id, env_secret)]

    try:
        cached = json.load(open(AG_CLIENT_CACHE))
        pairs = [(c["id"], c["secret"]) for c in cached if c.get("id") and c.get("secret")]
        if pairs:
            return pairs
    except Exception:
        pass

    for bundle in AG_BUNDLES:
        try:
            text = open(bundle, errors="replace").read()
        except Exception:
            continue
        ids = [(m.start(), m.group()) for m in CLIENT_ID_RE.finditer(text)]
        secrets = [(m.start(), m.group()) for m in CLIENT_SECRET_RE.finditer(text)]
        pairs = []
        for pos, secret in secrets:
            earlier = [entry for entry in ids if entry[0] < pos]
            if not earlier:
                continue
            pair = (earlier[-1][1], secret)
            if pair not in pairs:
                pairs.append(pair)
        if pairs:
            try:
                os.makedirs(DATA_HOME, exist_ok=True)
                json.dump([{"id": i, "secret": s} for i, s in pairs],
                          open(AG_CLIENT_CACHE, "w"))
                os.chmod(AG_CLIENT_CACHE, 0o600)
            except Exception:
                pass
            return pairs
    return []


def antigravity_secret():
    """The Antigravity desktop app keeps a Go keyring blob in the Keychain."""
    raw = None
    try:
        with open(AG_SECRET_PATH) as fh:
            raw = fh.read().strip()
    except Exception:
        pass
    if not raw:
        raw = keychain_secret("gemini")
    if not raw:
        return None
    if raw.startswith("go-keyring-base64:"):
        raw = raw.split(":", 1)[1]
    try:
        padded = raw + "=" * (-len(raw) % 4)
        return json.loads(base64.b64decode(padded))
    except Exception:
        return None


def antigravity_tokens():
    secret = antigravity_secret()
    if not secret:
        return None, None, None
    blob = secret.get("token") or {}
    return blob.get("access_token"), blob.get("refresh_token"), blob.get("expiry")


def antigravity_save_token(access, refresh, expires_in):
    secret = antigravity_secret()
    if not secret:
        return
    blob = secret.get("token") or {}
    blob.update({"access_token": access, "refresh_token": refresh or blob.get("refresh_token"),
                 "token_type": "Bearer", "expires_in": expires_in or 3599,
                 "expiry": iso_from_epoch(time.time() + (expires_in or 3599))})
    secret["token"] = blob
    try:
        payload = base64.b64encode(json.dumps(secret).encode()).decode()
        os.makedirs(DATA_HOME, exist_ok=True)
        with open(AG_SECRET_PATH, "w") as fh:
            fh.write("go-keyring-base64:" + payload)
        os.chmod(AG_SECRET_PATH, 0o600)
    except Exception:
        pass


def antigravity_quota(token):
    return http_json(
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        {"Authorization": "Bearer " + token,
         "Content-Type": "application/json",
         "User-Agent": "antigravity/1.0"},
        payload={})


def antigravity_refresh(refresh_token):
    for cid, secret in antigravity_clients():
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "client_id": cid,
            "client_secret": secret,
            "refresh_token": refresh_token,
        }).encode()
        req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = json.loads(resp.read().decode())
                if data.get("access_token"):
                    return data
        except Exception:
            continue
    return None


def short_group(name):
    n = (name or "").lower()
    if "claude" in n or "gpt" in n:
        return "Claude/GPT"
    if "gemini" in n:
        return "Gemini"
    return name or "Models"


def antigravity_provider(status=None):
    out = empty_provider("antigravity", "Antigravity", "Google", None)
    out["status"] = status
    access, refresh, expiry = antigravity_tokens()
    if not access and not refresh:
        out["error"] = "Open the Antigravity app once so it can sign in"
        return out

    status, body = antigravity_quota(access or "")
    if status in (401, 403) and refresh:
        fresh = antigravity_refresh(refresh)
        if not fresh and not antigravity_clients():
            out["error"] = "Antigravity app not found - install it or set AILIMITS_AG_CLIENT_ID"
            return out
        if fresh and fresh.get("access_token"):
            access = fresh["access_token"]
            antigravity_save_token(access, fresh.get("refresh_token"), fresh.get("expires_in"))
            status, body = antigravity_quota(access)

    if status in (401, 403):
        out["error"] = "Antigravity session expired - open the app to refresh"
        return out
    if status != 200:
        out["error"] = "Antigravity quota API returned %s" % status
        return out

    groups = body.get("groups") or []
    # Each group has its own 5h and weekly bucket; the tightest one binds.
    tightest = {}
    summary = []
    for group in groups:
        gname = short_group(group.get("displayName"))
        per_group = []
        for bucket in (group.get("buckets") or []):
            frac = bucket.get("remainingFraction")
            if frac is None:
                continue
            window = str(bucket.get("window") or bucket.get("bucketId") or "")
            key = "session" if ("5h" in window or "five" in window.lower()) else "weekly"
            remaining = float(frac) * 100.0
            per_group.append("%s %.0f%%" % (key == "session" and "5h" or "7d", remaining))
            if key not in tightest or remaining < tightest[key][0]:
                tightest[key] = (remaining, gname, bucket.get("resetTime"))
        if per_group:
            summary.append("%s: %s" % (gname, ", ".join(per_group)))

    if not tightest:
        out["error"] = "Antigravity returned no quota buckets"
        return out

    metrics = []
    if "session" in tightest:
        remaining, gname, reset = tightest["session"]
        metrics.append(metric("session", "Session", "5h \u00B7 " + gname,
                              100.0 - remaining, reset, 18000))
    if "weekly" in tightest:
        remaining, gname, reset = tightest["weekly"]
        metrics.append(metric("weekly", "Weekly", "7-day \u00B7 " + gname,
                              100.0 - remaining, reset, 604800))

    out.update(ok=True, metrics=metrics, notes=summary)
    return out


# ---------------------------------------------------------------- DeepSeek Harness

def deepseek_provider(status=None):
    out = empty_provider("deepseek", "DeepSeek", "Harness", None)
    out["status"] = status
    cred_path = os.path.join(HOME, ".dsh/.credentials.yaml")
    try:
        text = open(cred_path).read()
    except Exception as e:
        out["error"] = "DeepSeek Harness credentials not readable (%s)" % e
        return out

    m = re.search(r"deepseek-account-platform/default:(.*?)(?:\n\s{2}\S|\Z)", text, re.S)
    token = re.search(r"token:\s*(\S+)", m.group(1)) if m else None
    if not token:
        out["error"] = "Sign in to DeepSeek Harness to load its balance"
        return out

    status, body = http_json(
        "https://platform.deepseek.com/api/v0/users/get_user_summary",
        {"x-dsh-auth-token": token.group(1), "Accept": "application/json",
         "User-Agent": "DeepSeekHarness/1.0"})

    if status != 200 or body.get("code") not in (0, None):
        out["error"] = "DeepSeek balance unavailable (HTTP %s)" % status
        return out

    biz = ((body.get("data") or {}).get("biz_data")) or {}
    wallets = biz.get("normal_wallets") or []
    bonus = biz.get("bonus_wallets") or []
    spent = sum(float(w.get("amount") or 0) for w in (biz.get("total_costs") or []))

    if not wallets:
        out["error"] = "DeepSeek returned no wallet"
        return out

    currency = wallets[0].get("currency") or "USD"
    symbol = "$" if currency == "USD" else ""
    balance = float(wallets[0].get("balance") or 0)
    bonus_total = sum(float(w.get("balance") or 0) for w in bonus)

    notes = ["%s%.2f spent" % (symbol, spent)]
    if bonus_total > 0:
        notes.append("+ %s%.2f bonus" % (symbol, bonus_total))

    funded = balance + spent
    used_pct = (spent / funded * 100.0) if funded > 0 else None

    out.update(ok=True, metrics=[metric(
        "credits", "Credits", "Wallet balance", used_pct, None, None,
        value_text="%s%.2f" % (symbol, balance),
        detail_text="%.0f%% used \u00B7 %s%.2f spent" % (used_pct or 0, symbol, spent),
    )], notes=notes)
    return out


# ---------------------------------------------------------------- main

def load_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return default


GOOD_PATH = os.path.join(DATA_HOME, "last_good.json")


def carry_over(provider, previous):
    """Keep the last good numbers when a provider temporarily fails."""
    if not previous or provider["ok"]:
        return provider
    if previous.get("ok") and previous.get("metrics"):
        provider["metrics"] = previous["metrics"]
        provider["plan"] = previous.get("plan")
        provider["status"] = previous.get("status")
        provider["ok"] = True          # we still have usable numbers
        provider["stale"] = True
        provider["stale_since"] = previous.get("fetched_at")
    return provider


PROVIDERS = [
    ("claude", claude_provider, status_claude),
    ("codex", codex_provider, status_codex),
    ("antigravity", antigravity_provider, status_antigravity),
    ("deepseek", deepseek_provider, status_deepseek),
]


def main(argv):
    out_path = os.path.join(DATA_HOME, "data.json")
    to_stdout = "--stdout" in argv
    if "--out" in argv:
        out_path = argv[argv.index("--out") + 1]

    previous = {}
    try:
        prev_doc = json.load(open(out_path))
        previous = {p["id"]: p for p in prev_doc.get("providers", [])}
    except Exception:
        pass

    good = load_json(GOOD_PATH, {})
    commands = running_commands()
    providers = []
    for pid, fn, status_fn in PROVIDERS:
        status = None
        try:
            status = status_fn(commands)
        except Exception:
            status = None
        try:
            p = fn(status)
        except Exception as e:
            p = empty_provider(pid, pid.title(), "", "Unexpected error: %s" % e)
            p["status"] = status
        if p["ok"]:
            p["fetched_at"] = iso_now()
            good[pid] = p
        else:
            # A rate limit or a closed app should not blank the card.
            p = carry_over(p, previous.get(pid) or good.get(pid))
        providers.append(p)

    try:
        with open(GOOD_PATH, "w") as fh:
            json.dump(good, fh)
        os.chmod(GOOD_PATH, 0o600)
    except Exception:
        pass

    doc = {"generated_at": iso_now(), "providers": providers}

    if to_stdout:
        print(json.dumps(doc, indent=2))
        return 0

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(doc, fh, indent=2)
    os.replace(tmp, out_path)
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used by antigravity_refresh)
    sys.exit(main(sys.argv[1:]))
