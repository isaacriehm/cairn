# Cairn — Agent plugin (Claude Code + Cursor)

The agent-plugin frontend for Cairn: a state + context-loading layer that
reads your project once, then keeps your AI assistant aware of its
decisions, rules, and components so it stays consistent instead of
re-guessing.

This package ships **one** bundle (`dist/cli.mjs`) and **one** copy each of
skills, agents, and commands. Claude Code and Cursor each have their own
manifest and hook/MCP wiring in the same tree — no sync-from-sibling package.

## Layout

| Path | What |
| ---- | ---- |
| `.claude-plugin/plugin.json` | Claude Code manifest |
| `.cursor-plugin/plugin.json` | Cursor manifest (`hooks` → `hooks/hooks.cursor.json`) |
| `.mcp.json` | Claude MCP (`CLAUDE_PLUGIN_ROOT`) |
| `mcp.json` | Cursor MCP (`CURSOR_PLUGIN_ROOT`, `CAIRN_REPO_ROOT=${CURSOR_PROJECT_DIR}`) |
| `hooks/hooks.json` | Claude: SessionStart, SessionEnd, Stop, UserPromptSubmit, PostToolUse |
| `hooks/hooks.cursor.json` | Cursor: sessionStart, sessionEnd, stop, postToolUse |
| `rules/cairn-ground-state.mdc` | Cursor alwaysApply ground-state rule |
| `skills/` | cairn-adopt, cairn-adopt-components, cairn-direction, cairn-attention |
| `agents/` | reviewer, curator-map, curator-reduce, component-annotator, component-registrar |
| `commands/` | cairn-init, cairn-direction, cairn-resume, cairn-statusline-setup (Claude only) |
| `bin/cairn` | The `cairn` CLI, on the Bash tool's PATH while the Claude plugin is enabled |
| `dist/` | The committed, minified bundle (`cli.mjs` + templates) both frontends call |

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

See `docs/PLUGIN_ARCHITECTURE.md` for the full design and version cadence.
