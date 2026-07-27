# Cairn — Agent plugin (Claude Code + Cursor + Codex)

The agent-plugin frontend for Cairn: a state + context-loading layer that
reads your project once, then keeps your AI assistant aware of its
decisions, rules, and components so it stays consistent instead of
re-guessing.

This package ships **one** bundle (`dist/cli.mjs`) and **one** copy each of
skills, agents, and commands. Claude Code, Cursor, and Codex each have thin
host-specific manifest and hook/MCP wiring in the same tree—there is no
sync-from-sibling package and no duplicated runtime.

Each host adapter also pins Cairn's shared model runner to its own
authenticated CLI: Claude uses `claude`, Cursor uses `cursor-agent`, and
Codex uses `codex` with `gpt-5.3-codex-spark` for bounded backend tasks.
Queueing, caching, timeouts, tracing, and structured-output validation are
shared rather than reimplemented per host. Codex is sandboxed read-only;
Cursor runs without `--force` in a temporary workspace with deny-all project
permissions for shell, read, and write tools.

## Layout

| Path | What |
| ---- | ---- |
| `.claude-plugin/plugin.json` | Claude Code manifest |
| `.cursor-plugin/plugin.json` | Cursor manifest (`hooks` → `hooks/hooks.cursor.json`) |
| `.codex-plugin/plugin.json` | Codex Desktop/CLI manifest |
| `.mcp.json` | Claude MCP (`CLAUDE_PLUGIN_ROOT`) |
| `mcp.json` | Cursor MCP (`CURSOR_PLUGIN_ROOT`, `CAIRN_REPO_ROOT=${CURSOR_PROJECT_DIR}`) |
| `.mcp.codex.json` | Codex bundled MCP (`PLUGIN_ROOT`) |
| `hooks/hooks.json` | Claude: SessionStart, SessionEnd, Stop, UserPromptSubmit, PostToolUse |
| `hooks/hooks.cursor.json` | Cursor native v1: sessionStart, sessionEnd, stop, postToolUse |
| `hooks/hooks.codex.json` | Codex: SessionStart, Stop, UserPromptSubmit, PostToolUse |
| `rules/cairn-ground-state.mdc` | Cursor alwaysApply ground-state rule |
| `skills/` | cairn-adopt, cairn-adopt-components, cairn-direction, cairn-attention |
| `agents/` | reviewer, curator-map, curator-reduce, component-annotator, component-registrar |
| `commands/` | cairn-init, cairn-direction, cairn-resume, cairn-statusline-setup (Claude only) |
| `bin/cairn` | The `cairn` CLI, on the Bash tool's PATH while the Claude plugin is enabled |
| `dist/` | The committed, minified bundle (`cli.mjs` + templates) all hosts call |

## Install

**Claude Code**

```
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
```

**Cursor**

```
Settings → Cursor → Plugins → Add from GitHub → isaacriehm/cairn
```

**Codex CLI**

```bash
codex plugin marketplace add isaacriehm/cairn
codex plugin add cairn@cairn
```

Codex Desktop reads the same repo marketplace from
`.agents/plugins/marketplace.json`. Restart the app, open **Plugins**, select
the Cairn source, install Cairn, then review and trust its bundled hooks.

See `docs/PLUGIN_ARCHITECTURE.md` for the full design and version cadence.
