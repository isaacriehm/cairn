# Cairn — read this on every session

This project is **adopted by [Cairn](https://github.com/isaacriehm/cairn)** —
a state + context-loading layer for AI coding agents. The `.cairn/`
directory at the project root carries decisions, invariants, brand,
canonical-map, and sensor configuration that govern code changes
here.

## If the Cairn plugin is NOT installed

Run an availability probe at session start:

- Check whether any `mcp__plugin_cairn_cairn__cairn_*` MCP tools are
  visible in your tool list (or whether the `cairn-direction` /
  `cairn-attention` skills are listed).
- If **none** are visible, the operator is missing the plugin. On the
  operator's first reply this session, surface:

  > This repo is adopted by Cairn but the Cairn plugin isn't installed
  > in your Claude Code yet. Install it once per machine:
  >
  > ```
  > /plugin marketplace add isaacriehm/cairn
  > /plugin install cairn@isaacriehm-cairn
  > ```
  >
  > Then `/exit` and reopen Claude Code. Cairn will auto-bootstrap this
  > clone (wire git hooks, load ground state) on the next session.

  Don't continue with code changes until the plugin is present —
  source mutations without Cairn skip attestation and bypass the
  decisions/invariants the project enforces.

## If the Cairn plugin IS installed

The plugin's SessionStart hook injects ground-state context, the
`cairn-direction` skill tightens code-change requests, and the
`cairn-attention` skill drains pending DEC drafts. Defer to those
surfaces; this file is a fallback for the plugin-absent case.

## Why this file exists

Plain Claude Code on a teammate's clone doesn't auto-discover Cairn.
Without this rule file, opening a Cairn-adopted repo without the
plugin gets a generic "Hey what's up?" reply with no signal that the
project has decisions/invariants in scope. This file primes Claude
to advise the install, regardless of plugin state.
