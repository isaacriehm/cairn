---
description: Wire the Cairn `⬡` statusline badge into user-level Claude Code settings. One-time per machine.
---

# /cairn:cairn-statusline-setup

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
- `[b]` skip — re-run `/cairn:cairn-statusline-setup` later

## Step 2 — locate the shim file

The plugin's SessionStart hook writes the bundle's current path to
`~/.claude/plugins/cache/<slug>/.active-version-path` on every session
open, where `<slug>` is the marketplace name Claude Code installed the
plugin under. The shim is a single line: the absolute path to the
active `dist/cli.mjs`. Resolve it with a Node glob over
`~/.claude/plugins/cache/*/.active-version-path` that picks the
most-recently-written shim by `mtime` — never hardcode the slug:

```js
const { readdirSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const base = join(homedir(), '.claude', 'plugins', 'cache');
let shim = null, newest = 0;
for (const slug of readdirSync(base)) {
  const p = join(base, slug, '.active-version-path');
  try {
    const m = statSync(p).mtimeMs;
    if (m >= newest) { newest = m; shim = p; }
  } catch {}
}
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
`statusLine` entry. The command is a shell-free Node one-liner — it
runs the same on macOS, Linux, and native Windows (cmd/PowerShell)
because Node, not a shell, performs the glob, mtime sort, file read,
and re-spawn. (User-level `statusLine` cannot use `${CLAUDE_PLUGIN_ROOT}`
— that variable is only expanded for plugin hooks/MCP/LSP — so the
launcher must discover the bundle itself.)

```json
{
  "statusLine": {
    "type": "command",
    "command": "node -e \"const f=require('node:fs'),{homedir}=require('node:os'),{join}=require('node:path'),{spawnSync}=require('node:child_process');const C=join(homedir(),'.claude','plugins','cache');const newest=a=>{let b=null,t=-1;for(const p of a){try{const m=f.statSync(p).mtimeMs;if(m>t){t=m;b=p}}catch{}}return b};const slugs=()=>{try{return f.readdirSync(C).filter(s=>f.existsSync(join(C,s,'.active-version-path')))}catch{return[]}};let cli=null;const sh=newest(slugs().map(s=>join(C,s,'.active-version-path')));if(sh){try{const c=f.readFileSync(sh,'utf8').trim();if(c&&f.existsSync(c))cli=c}catch{}}if(!cli){const z=[];for(const s of slugs()){const pd=join(C,s,'cairn');let vs;try{vs=f.readdirSync(pd)}catch{continue}for(const v of vs){const p=join(pd,v,'dist','cli.mjs');if(f.existsSync(p))z.push(p)}}cli=newest(z)}if(cli)process.exit(spawnSync(process.execPath,[cli,'status-line'],{stdio:'inherit'}).status??0)\"",
    "refreshInterval": 10
  }
}
```

The launcher resolves the bundle in two steps, then re-spawns it with
`stdio: 'inherit'` so Claude Code's stdin payload reaches `cairn
status-line` and the rendered badge flows back out:

1. **Shim** — newest `~/.claude/plugins/cache/*/.active-version-path`
   (the SessionStart hook rewrites it to the live `cli.mjs` every
   session), but only if the path it points at still exists.
2. **Fallback** — if the shim is missing or dangles (e.g. the operator
   deleted the pointed-to version dir before a new session refreshed
   it), glob the newest `cache/<slug>/cairn/<version>/dist/cli.mjs`
   directly. Both steps consider only slugs that carry an
   `.active-version-path` (cairn's own marker) and the `cairn` plugin
   dir, so the launcher never spawns another plugin's bundle. This
   self-heals a stale pointer with no manual repair.

No `bash`, `ls`, `head`, shell `*` glob, or `~` expansion — so it works
natively on Windows as well as macOS/Linux. `refreshInterval: 10` keeps
the badge live during long subagent runs.

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
