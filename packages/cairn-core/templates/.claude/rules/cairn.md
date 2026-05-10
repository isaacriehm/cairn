# Cairn — read this on every session

This project is adopted by [Cairn](https://github.com/isaacriehm/cairn).
The `.cairn/` directory carries decisions, invariants, brand, canonical-map,
and sensor configuration that govern code changes here.

## Plugin probe

If you cannot see `mcp__plugin_cairn_cairn__cairn_*` MCP tools or the
`cairn-direction` / `cairn-attention` skills, the operator is missing
the plugin. Surface on the first reply:

> Cairn plugin not installed. Run once per machine:
>
> ```
> /plugin marketplace add isaacriehm/cairn
> /plugin install cairn@isaacriehm-cairn
> ```
>
> Then `/exit` and reopen. Auto-bootstrap fires on the next session.

Do not continue code changes until the plugin is present — source
mutations without Cairn skip attestation and bypass the
decisions/invariants the project enforces.

When the plugin IS installed, defer entirely to its SessionStart
context block, `cairn-direction`, and `cairn-attention` surfaces.
This file is the fallback for the plugin-absent case.
