# Security policy

## Reporting a vulnerability

Report it privately through GitHub:
**[Report a vulnerability](https://github.com/isaacriehm/cairn/security/advisories/new)**.
Don't open a public issue.

Include the Cairn version (`cairn --version`, or the plugin version), the
host (Claude Code, Cursor, Codex, or CLI only), and steps to reproduce.
Replies happen on the advisory thread.

## Supported versions

Cairn is pre-1.0. Fixes land in the latest release only.

## What's in scope

Cairn runs locally with your permissions. It executes git hooks, runs
agent-host hooks on every session, and spawns `claude`, `cursor-agent`, or
`codex` for model calls. The issues that matter most:

- command injection through hook payloads, file paths, or `.cairn/` content
- writes outside the paths Cairn documents (the repository, `~/.cairn`,
  its log directory, and the one `~/.claude/settings.json` key adoption sets)
- a model call escaping its sandbox (Codex read-only mode, or Cursor's
  isolated workspace with shell, read, and write denied)
- a way to make the pre-commit or CI sweep pass when it shouldn't
