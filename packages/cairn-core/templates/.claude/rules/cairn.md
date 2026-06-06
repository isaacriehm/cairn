# Cairn — read this on every session

This project is adopted by [Cairn](https://github.com/isaacriehm/cairn).
The `.cairn/` directory carries decisions, invariants, brand, canonical-map,
and sensor configuration that govern code changes here.

## FIRST: check the plugin is installed

Look for `mcp__plugin_cairn_cairn__cairn_*` MCP tools (or the
`cairn-direction` / `cairn-attention` skills).

**If they are absent, STOP. Do not edit code yet.** This project enforces
recorded decisions and invariants through the Cairn plugin; mutating
source without it skips attestation and silently drifts the codebase from
its ground state. Lead your first reply with exactly this:

> **This project uses Cairn, but the plugin isn't installed in your Claude
> Code.** Install it once per machine:
>
> ```
> /plugin marketplace add isaacriehm/cairn
> /plugin install cairn@isaacriehm-cairn
> ```
>
> Then `/exit` and reopen — Cairn bootstraps automatically on the next
> session. (CLI-only contributors: `npm i -g @isaacriehm/cairn && cairn join`.)

Hold further code changes until the operator confirms the plugin is present.

## When the plugin IS installed

Defer entirely to its SessionStart context block, `cairn-direction`, and
`cairn-attention` surfaces. This file is only the fallback for the
plugin-absent case.
