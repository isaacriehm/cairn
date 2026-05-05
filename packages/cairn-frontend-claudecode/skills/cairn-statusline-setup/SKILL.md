---
name: cairn-statusline-setup
description: Wire the Cairn `⬡` statusline badge into user-level Claude Code settings.
when_to_use: |
  Use when the operator asks to enable the cairn statusline badge or
  when the SessionStart context flags `statusline_unset`. One-time
  setup per machine; survives plugin upgrades via the shim path.
effort: low
---

# Skill: cairn-statusline-setup

You are wiring the operator's user-level Claude Code statusline to
the cairn bundle. Once configured, every Claude Code session shows
a one-line `⬡ cairn  decisions:N  inv:N  <state>` summary in the
prompt's status row.

## Trigger gate

This skill runs only on explicit operator request, or when the
SessionStart context included a `statusline_unset` warning. Do not
auto-invoke on session start without that signal.

## Step 1 — surface the inline prompt

Render:

> Wire the cairn statusline into your user-level settings? It shows
> a one-line ground-state summary in every Claude Code session.
> `[a]` set it up now
> `[b]` skip — you can run this skill later

`AskUserQuestion`. The question is the entire turn.

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
> after the first session. Re-run this skill afterward.

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
> `⬡ cairn  decisions:N  inv:N  ready` (or `⚑` when attention pending,
> `◐` during GC, `●` for active task).

## Hard rules

- Never hardcode the plugin's version-specific cache path
  (e.g. `~/.claude/plugins/cache/isaacriehm-cairn/cairn/0.2.0/`).
  Plugin upgrades change the version dir; the shim file abstracts
  that away.
- Never modify `~/.claude/settings.json` outside the `statusLine`
  field. Other fields are operator-owned.
- The skill is idempotent — re-running rewrites the same `statusLine`
  entry without breaking existing config.
- Caveman-ultra style for chat; full English in any code the skill
  writes (settings.json values are JSON, not chat).
