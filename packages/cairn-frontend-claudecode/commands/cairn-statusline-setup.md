---
description: Wire the Cairn `⬡` statusline badge into user-level Claude Code settings. One-time per machine.
---

# /cairn-statusline-setup

Wire this developer's `~/.claude/settings.json` statusline to the
cairn bundle. Once configured, every Claude Code session shows a
compact one-line badge in the prompt's status row:

```
⬡ cairn  [signal]  [ctx-meter pct%]
```

Signal priority (first match wins, blank when nothing applies):

- `⚠ N unattested` — bypass commits since cairn init
- `⚑ N draft[s]` — pending decision drafts in attention queue
- `◐ gc` — GC sweep in progress
- `TSK-NNNN <title>` — active task in flight
- (idle) — blank; just brand + ctx meter

## Step 1 — surface the inline prompt

Render via `AskUserQuestion`:

> Wire the cairn statusline into your user-level settings? It shows
> a one-line ground-state summary in every Claude Code session.

- `[a]` set it up now
- `[b]` skip — re-run `/cairn-statusline-setup` later

## Step 2 — locate the shim file

The plugin's SessionStart hook writes the bundle's current path to
`~/.claude/plugins/cache/isaacriehm-cairn/.active-version-path` on
every session open. The shim file is a single line: the absolute
path to the active `dist/cli.mjs`.

Verify it exists:

```bash
test -f ~/.claude/plugins/cache/isaacriehm-cairn/.active-version-path \
  && echo OK \
  || echo MISSING
```

If `MISSING`, the plugin hasn't run a SessionStart yet for this
project — surface:

> Cairn's plugin hasn't fired SessionStart yet on this project. Open
> Claude Code in a cairn-adopted repo first; the shim file appears
> after the first session. Re-run this command afterward.

End the turn.

## Step 3 — patch user settings.json

Read `~/.claude/settings.json` (create with `{}` if missing). Set the
`statusLine` entry to:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$(cat ~/.claude/plugins/cache/isaacriehm-cairn/.active-version-path)\" status-line",
    "refreshInterval": 30
  }
}
```

The `refreshInterval: 30` keeps the badge live during long subagent
runs — without it the row goes stale because main-session events
don't tick while a subagent is in flight.

Preserve any other top-level fields. Use the `Edit` tool with the
existing file content as `old_string` to do the merge atomically.

## Step 4 — confirm + suggest restart

> Statusline configured. Restart Claude Code to see the badge appear.
> Idle sessions show `⬡ cairn  [ctx pct%]`; mid-flight tasks render
> `TSK-NNNN <title>`; pending attention adds `⚑ N draft[s]`; bypass
> commits add `⚠ N unattested`.

## Hard rules

- Never hardcode the plugin's version-specific cache path
  (e.g. `~/.claude/plugins/cache/isaacriehm-cairn/cairn/0.2.0/`).
  Plugin upgrades change the version dir; the shim file abstracts
  that away.
- Never modify `~/.claude/settings.json` outside the `statusLine`
  field. Other fields are operator-owned.
- The command is idempotent — re-running rewrites the same `statusLine`
  entry without breaking existing config.
