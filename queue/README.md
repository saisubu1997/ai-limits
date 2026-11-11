# Work queue

A phone-first PWA for handing tasks to your agents, served from the same Mac bridge
as the limits widget. Installable on iPhone (Share -> Add to Home Screen).

![Work queue on a phone](../docs/queue.png)

`http://<your-mac>.local:8787/t/<token>/queue/`

## How it works

1. Describe a task and pick a model.
2. The Mac runs it headlessly with that app's own CLI.
3. Output streams back into the card, and the status goes queued -> running -> done/failed.

## Which models can actually run

| Model | Runner | Notes |
|-------|--------|-------|
| Claude | the Claude Code CLI bundled inside Claude.app | authenticated with the OAuth token already stored by Claude Desktop (`CLAUDE_CODE_OAUTH_TOKEN`) |
| Codex | `codex-cli` bundled inside the ChatGPT app | uses the existing `~/.codex/auth.json` |
| Antigravity | none | the desktop app has no CLI, so the task is marked **Manual** - open the app and paste it |
| DeepSeek | none | same: the Harness has no CLI, so it is marked **Manual** |

Tasks are honest about this: a Manual card says so instead of pretending to run.

**Open <App>.** Every card has an action that brings the matching Mac app forward
(`open -b <bundle-id>`, falling back to the .app path). It is shown inline on Manual
cards so you can hand the task straight over, and in the expanded actions on the rest.
Tapping it from your phone opens the app **on the Mac**.

## Phone app (Supabase + GitHub Pages)

**https://saisubu1997.github.io/ai-limits/queue/** - open on your phone, then
Share -> Add to Home Screen. It has three tabs:

* **Runs** - every task as a thread. Open one to watch the output stream in and
  reply to continue the same Claude / ChatGPT (Codex) session.
* **Sessions** - recent sessions from the Mac with their latest messages; reply to
  continue any Claude or Codex session from the phone.
* **Apps** - start a task for an app, or bring the app forward on the Mac.

Antigravity and DeepSeek Harness have no headless CLI, so their tasks are a
hand-off: the Mac opens the app and puts your prompt on the clipboard.

Supabase is the backend (Auth, Postgres, Realtime). The page itself is served by
GitHub Pages, because Supabase does not serve HTML from `*.supabase.co`: Storage
returns it as `text/plain` and Edge Functions rewrite `text/html` to `text/plain`
unless the project has a paid custom domain.

### One-time setup

1. Sign up in the phone app (confirm the email Supabase sends).
2. Apply the schema: paste [`../supabase.sql`](../supabase.sql) into the SQL editor
   and run it (or pass `SUPABASE_ACCESS_TOKEN` to the next step).
3. Link this Mac:

   ```bash
   ./connect-supabase.sh https://YOUR-PROJECT.supabase.co ANON_KEY SERVICE_ROLE_KEY you@email
   ```

   It checks the tables, finds your account, saves the keys on this Mac and waits
   for the Mac heartbeat. The phone then shows **Mac online**.

### Security

* Row Level Security limits every row to the signed-in owner; the anon key that is
  embedded in the public page can read or write nothing by itself.
* The Mac uses the `service_role` key, stored only in `~/.limitswidget/queue.db`.
* The Mac only runs tasks owned by the linked account. Still, turn off new sign-ups once your account
  exists: **Authentication -> Providers -> Email -> Allow new users to sign up**.

## Requirements

* macOS with the limits widget installed (`../install.sh`)
* Claude Desktop signed in for Claude runs; the ChatGPT/Codex app for Codex runs
* Optional: `pip3 install --user zstandard` (only affects DeepSeek titles on the limits card)

## Files

```
server.py             task store (SQLite), runner, REST API, Supabase sync
web/                  the PWA (installable, offline shell)
connect-supabase.sh   link the Mac to Supabase + verify
```

Tasks live in `~/.limitswidget/queue.db`; delete a row from the UI or drop the file to reset.
