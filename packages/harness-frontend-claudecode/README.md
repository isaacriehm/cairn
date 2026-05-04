# @devplusllc/harness-frontend-claudecode

Claude Code plugin frontend for harness — the invisible project maintainer.

## Layout

```
.claude-plugin/plugin.json    — plugin manifest
.mcp.json                     — registers harness-core MCP server (stdio)
hooks/hooks.json              — SessionStart, SessionEnd, Stop, PostToolUse[Read|Grep|Glob,Write|Edit]
skills/                       — adopt, direction, attention (added in step 5)
agents/                       — reviewer (added in step 6)
commands/                     — harness-init, harness-direction (added in step 5)
scripts/check-layout.mjs      — `pnpm build` validator
```

## Bin paths

Hooks and MCP are wired with node-direct paths to compiled harness-core
output:

```
node ${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/hooks/<event>.js
node ${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/mcp/serve.js
```

So the plugin works without the `harness` umbrella CLI being on PATH.
The umbrella CLI's `harness hook <event>` subcommand calls the same
runners as a debug/dev escape hatch.

## Distribution

Install via `/plugin marketplace add devplusllc/harness` then
`/plugin install harness@devplusllc-harness`.

See `docs/PLUGIN_ARCHITECTURE.md` §5 for distribution + version cadence.
