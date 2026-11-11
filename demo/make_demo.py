#!/usr/bin/env python3
"""Generates demo/data.json with fictional accounts, for screenshots and UI work."""
import json
import os
from datetime import datetime, timedelta, timezone

now = datetime.now(timezone.utc)


def at(hours=0, days=0):
    return (now + timedelta(hours=hours, days=days)).isoformat()


def metric(mid, label, sub, remaining, reset, window, value=None, detail=None):
    return {
        "id": mid, "label": label, "sublabel": sub,
        "used_pct": None if remaining is None else round(100 - remaining, 1),
        "remaining_pct": remaining,
        "reset_at": reset, "window_secs": window,
        "value_text": value, "detail_text": detail,
    }


providers = [
    {
        "id": "claude", "name": "Claude", "vendor": "Anthropic", "plan": "Team",
        "account": None, "ok": True, "stale": False, "error": None,
        "metrics": [metric("session", "Session", "5-hour window", 38, at(hours=3), 18000),
                    metric("weekly", "Weekly", "7-day window", 89, at(days=5), 604800)],
        "notes": [],
        "status": {"running": True, "sessions": 1, "state": "waiting",
                   "session_name": "Refactor the settings page"},
    },
    {
        "id": "codex", "name": "Codex", "vendor": "OpenAI", "plan": "Team",
        "account": "dev@example.com", "ok": True, "stale": False, "error": None,
        "metrics": [metric("session", "Session", "5-hour window", 28, at(hours=1), 18000),
                    metric("weekly", "Weekly", "7-day window", 54, at(days=4), 604800)],
        "notes": [],
        "status": {"running": True, "sessions": 1, "state": "working",
                   "session_name": "Build usage dashboard"},
    },
    {
        "id": "antigravity", "name": "Antigravity", "vendor": "Google", "plan": None,
        "account": None, "ok": True, "stale": False, "error": None,
        "metrics": [metric("session", "Session", "5h \u00B7 Gemini", 100, at(hours=5), 18000),
                    metric("weekly", "Weekly", "7-day \u00B7 Gemini", 98, at(days=5), 604800)],
        "notes": [],
        "status": {"running": False, "sessions": 0, "state": "idle", "session_name": None},
    },
    {
        "id": "deepseek", "name": "DeepSeek", "vendor": "Harness", "plan": None,
        "account": None, "ok": True, "stale": False, "error": None,
        "metrics": [metric("credits", "Credits", "Wallet balance", 62, None, None,
                           value="$12.40", detail="38% used \u00B7 $7.60 spent")],
        "notes": [],
        "status": {"running": True, "sessions": 0, "state": "idle", "session_name": "demo-workspace"},
    },
]

doc = {"generated_at": now.isoformat(), "providers": providers}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
with open(out, "w") as fh:
    json.dump(doc, fh, indent=2)
print("wrote", out)
