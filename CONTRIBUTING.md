# Contributing to Cairn

Cairn has one maintainer. Small, focused PRs get reviewed fastest. For
anything that changes package boundaries, the plugin contract, or the
`.cairn/` layout, open an issue first. Those designs are locked in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) and aren't
reopened casually.

## Setup

Node 22 (see `.nvmrc`) and pnpm 11 (pinned in `package.json#packageManager`;
`corepack enable` picks it up).

```bash
git clone https://github.com/isaacriehm/cairn
cd cairn
pnpm install
pnpm build
pnpm smokes
```

## Checks a PR must pass

| Command | What it checks |
| --- | --- |
| `pnpm version:check` | Every package and plugin manifest is on the same version. |
| `pnpm build` | All packages compile, and the plugin bundle rebuilds. |
| `pnpm typecheck` | Types across the workspace. |
| `pnpm smokes` | The default smoke gate. CI runs a subset of it plus the Lens smokes. |

Tests are end-to-end smoke scripts in `packages/cairn/scripts/smoke-*.ts`.
Each builds a throwaway repo and drives the real CLI, hooks, or MCP server.
A bug fix should come with a smoke that fails before the fix.
`pnpm smoke:llm-prompt-eval` makes real model calls and is opt-in. Run it
only when you change a model prompt or a provider transport.

## Things that are easy to get wrong

- **The plugin bundle is committed.** `packages/cairn-plugin/dist/` is
  tracked because the plugin installs straight from this repo. If you change
  `cairn-core` or `cairn`, run `pnpm build` and commit the updated bundle.
- **No Claude Code `PreToolUse` hooks.** They can wedge a session. Use
  SessionStart context and MCP tools instead.
- **Model calls name a tier.** Use the shared runner's `fast` or `capable`
  tier. Don't use a dated model ID, an environment variable, or the
  session's model.
- **Hard cutovers.** Don't add compatibility shims. A state format change
  ships with a `cairn migrate` migration.
- **Keep other projects out of the repo.** If you found a bug by running
  Cairn on another codebase, describe the mechanism. Don't put that
  project's name, paths, or file names in code, docs, or commit messages.

## Commits and changelog

Commit messages follow Conventional Commits (`fix(core): …`,
`feat(plugin): …`). Add a line under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md) for any user-visible change. The maintainer
handles releases; pushing a `vX.Y.Z` tag publishes to npm.
