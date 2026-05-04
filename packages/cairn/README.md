# @isaacriehm/cairn

The `cairn` CLI binary. Bootstrap + debug entrypoint for the Cairn state +
context-loading layer.

## Install

```bash
npm install -g @isaacriehm/cairn
```

## Subcommands

| Subcommand | What |
|------------|------|
| `cairn init` | One-time adoption walk for a new repo. Seeds `.cairn/`, runs the mapper, ingests existing docs + source comments + rules. |
| `cairn join` | Per-clone bootstrap. Sets `core.hooksPath = .cairn/git-hooks`, ensures sessions dir. Idempotent. |
| `cairn hook <event>` | Hook runners (SessionStart / SessionEnd / Stop / PostToolUse). Called by the Claude Code plugin. |
| `cairn mcp serve` | Stdio MCP server. Registered in the plugin's `.mcp.json`. |
| `cairn doctor` | Verify the local install is healthy. |
| `cairn fix` | Auto-resolve doctor warnings where possible. |
| `cairn attention` | List pending DEC drafts + baseline findings. |
| `cairn gc` | Garbage-collection sweep against canonical zone. |
| `cairn scope` | Scope-index commands (rebuild, etc.). |
| `cairn status-line` | Format the per-session Claude Code status line. |

The Claude Code plugin (`@isaacriehm/cairn-frontend-claudecode`) is the
primary operator surface; this CLI is what the plugin shells out to and
what new contributors run when bootstrapping a clone.

See the repo root [`README.md`](../../README.md) and
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the broader
picture.

## License

MIT — see [`../../LICENSE`](../../LICENSE).
