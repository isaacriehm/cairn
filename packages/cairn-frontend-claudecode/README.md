# Cairn — Claude Code plugin

The Claude Code frontend for Cairn: a state + context-loading layer that
reads your project once, then keeps your AI assistant aware of its
decisions, rules, and components so it stays consistent instead of
re-guessing.

This package is the plugin bundle. Everything runs through a single
self-contained build, `dist/cli.mjs`; the plugin wires it via hooks, an
MCP server, skills, agents, and commands.

## Layout

| Path | What |
| ---- | ---- |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.mcp.json` | Registers the `cairn` MCP server (`node dist/cli.mjs mcp serve`) |
| `hooks/hooks.json` | SessionStart, SessionEnd, Stop, UserPromptSubmit, PostToolUse (Read · Write\|Edit · AskUserQuestion) |
| `skills/` | cairn-adopt, cairn-adopt-components, cairn-direction, cairn-attention |
| `agents/` | reviewer, curator-map, curator-reduce, component-annotator, component-registrar |
| `commands/` | cairn-init, cairn-direction, cairn-resume, cairn-statusline-setup |
| `bin/cairn` | The `cairn` CLI, on the Bash tool's PATH while the plugin is enabled |
| `dist/` | The committed, minified bundle (`cli.mjs` + templates) the hooks call |

Every hook and MCP command invokes `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" …`
— self-contained, no global install, and no path traversal outside the
plugin root (which would break after a marketplace install).

## Install

```
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
```

See `docs/PLUGIN_ARCHITECTURE.md` for the full design and version cadence.
