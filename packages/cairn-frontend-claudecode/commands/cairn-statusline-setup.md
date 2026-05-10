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

Signal priority (first match wins):

- `⏳ adopt <phase> X/Y (P%) ~Nm` — live during cairn-adopt long phases
- `⚠ N unattested` — bypass commits since cairn init
- `⚑ N pending` — pending decision drafts in attention queue
- `◐ gc` — GC sweep in progress
- `TSK-... <title>` — active task in flight
- `✓ N·M` — **idle heartbeat** showing N decisions and M invariants in scope (positive signal that Cairn is alive)
- (empty) — fresh adoption with no ground state yet; just brand + ctx meter

## Step 1 — surface the inline prompt

Render via `AskUserQuestion`:

> Wire the cairn statusline into your user-level settings? It shows
> a one-line ground-state summary in every Claude Code session.

- `[a]` set it up now
- `[b]` skip — re-run `/cairn-statusline-setup` later

## Step 2 — locate the shim file

The plugin's SessionStart hook writes the bundle's current path to
`~/.claude/plugins/cache/<slug>/.active-version-path` on every session
open, where `<slug>` is the marketplace name Claude Code installed the
plugin under. The shim is a single line: the absolute path to the
active `dist/cli.mjs`. Locate it via glob — never hardcode the slug:

```bash
ls -1t ~/.claude/plugins/cache/*/.active-version-path 2>/dev/null \
  | head -1
```

If empty, the plugin's SessionStart hook hasn't fired even once for
the current install. Surface this enumerated cause list:

> Cairn shim not found at any `~/.claude/plugins/cache/*/` path. Likely
> causes:
>
> 1. The plugin isn't installed or isn't enabled — run `/plugin status`
>    and confirm `cairn` is active.
> 2. The plugin is installed but SessionStart hasn't fired yet for it
>    — `/exit` and reopen Claude Code, then re-run this command.
> 3. The bundle is missing — check
>    `<plugin-root>/dist/cli.mjs`. If absent, rebuild the plugin
>    (`pnpm --filter @isaacriehm/cairn-frontend-claudecode build`) or
>    reinstall via `/plugin install cairn@isaacriehm-cairn`.
> 4. `CLAUDE_PLUGIN_ROOT` env var was not injected. Older Claude Code
>    versions did not set it on every hook — upgrade Claude Code.
>
> The SessionStart hook also surfaces a banner with the underlying
> failure — open a session in any directory and look for
> `## Cairn — statusline shim issue`.

End the turn.

## Step 3 — patch user settings.json

Read `~/.claude/settings.json` (create with `{}` if missing). Set the
`statusLine` entry. The command uses a runtime glob so plugin slug
renames don't break it:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash -c 'shim=$(ls -1t ~/.claude/plugins/cache/*/.active-version-path 2>/dev/null | head -1); [ -n \"$shim\" ] && node \"$(cat \"$shim\")\" status-line'",
    "refreshInterval": 10
  }
}
```

The `bash -c` wrapper resolves the most-recently-written shim across
any plugin slug. `refreshInterval: 10` keeps the badge live during long
subagent runs.

Preserve any other top-level fields in `~/.claude/settings.json`. Use
the `Edit` tool with the existing file content as `old_string` to do
the merge atomically.

## Step 4 — confirm + suggest restart

> Statusline configured. Restart Claude Code to see the badge appear.
> Idle sessions show `⬡ cairn  ✓ <N>·<M>  [ctx pct%]`; mid-flight
> tasks render `TSK-... <title>`; pending attention adds
> `⚑ N pending`; bypass commits add `⚠ N unattested`.

## Hard rules

- **Never hardcode a specific plugin slug** in the statusline command.
  Slug renames break hardcoded paths; the runtime glob resolves
  whatever shim is freshest.
- Never modify `~/.claude/settings.json` outside the `statusLine`
  field. Other fields are operator-owned.
- The command is idempotent — re-running rewrites the same `statusLine`
  entry without breaking existing config.
