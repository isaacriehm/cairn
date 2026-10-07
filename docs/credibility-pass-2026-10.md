# Credibility pass — 2026-10

A review of the public repository as a first-time technical visitor sees it,
plus the fixes made on branch `credibility-pass`. Nothing was pushed, tagged,
published, or released. Every claim below comes from a command that was run.
Unverified items are labeled.

## Summary

- **Install paths work.** The Claude Code and Codex plugin installs from
  GitHub both succeed, and the npm CLI installs and runs. Both diff gates
  (stub catalog and decision assertions) block real violations at
  pre-commit and in CI.
- **The CLI quick start had one real gap.** It omitted `cairn join`, so the
  git hooks were never activated. The README also advertised a sensor that
  no longer exists and named two MCP tools that don't exist.
- **The biggest open credibility risk isn't in the README.** `pnpm audit --prod`
  reports 29 advisories, 3 of them critical (see
  [Open findings](#open-findings-not-fixed-here)).

## Before and after

| | Before (`main` @ 702a5bf) | After (`credibility-pass`) |
| --- | --- | --- |
| README | 517 lines. Opened with three install blocks, then a glossary, a 13-phase table, and feature lists. | 238 lines. Problem, a 20-second example from a real run, quick start, how it works (five packages), status and limits, docs index. |
| README accuracy | CLI path missing `cairn join`. Listed a "Structural" sensor that was deleted. Named `cairn_decisions_in_scope` and `cairn_supersedes_chain`, which don't exist. | Fixed. Every command in the quick start was run against 0.33.0 from npm. |
| Demo | None | [`docs/demo.md`](demo.md): verbatim transcript, with paths redacted only. |
| Package metadata | No `keywords` anywhere. `repository.directory` only on cairn-state. cairn-plugin had no license, author, or repository. cairn-core declared a README it didn't have. | Consistent across all five packages. cairn-core README added. |
| CHANGELOG | 103 version entries, but tags 0.1.0–0.1.10 and 0.4.3 had none. Only one link reference. No explanation of untagged versions. | Missing entries written from the release commits. Gaps explained. Link refs for all 95 tagged versions plus Unreleased. |
| Community files | LICENSE only (GitHub community health: 42%) | CONTRIBUTING, SECURITY, issue forms (bug, feature, config), PR template |
| CI on `main` | Green. Last run succeeded on 702a5bf. | Unchanged. The branch passes the same gates locally (below). |

No CODE_OF_CONDUCT was added. A one-maintainer project with no moderation
process gains nothing from boilerplate. Add one when there are other
maintainers to enforce it.

## Quick start test log

Environment: macOS, Node 24.20.0, npm 12.0.2, `claude` 2.1.290, `codex`
0.151.0. Every run used a throwaway `HOME` / `CLAUDE_CONFIG_DIR` /
`CODEX_HOME`, so no existing config was involved.

| # | Step | Result |
| --- | --- | --- |
| 1 | `npm install -g @isaacriehm/cairn@0.33.0` (isolated prefix) | Pass. 155 packages, about 3 s. `cairn --version` prints `0.33.0`. |
| 2 | `cairn init --no-prompt` in a fresh git repo | Pass. Seeds `.cairn/`, three git hooks, `.github/workflows/cairn-check.yml`, `.claude/rules/cairn.md`, `CLAUDE.md`. It skips the mapper and doc ingestion, so the ledger starts empty. |
| 3 | Check `git config core.hooksPath` after init | **Fail (docs).** Unset. The README's CLI path stopped at `cairn init`, so the pre-commit gate never ran. The fix is the documented `cairn join`. |
| 4 | `cairn join` | Pass. Sets `core.hooksPath = .cairn/git-hooks` and seeds bypass detection. |
| 5 | `cairn doctor` | Pass, 1 warning (empty scope index, expected with `--no-prompt`). Exit 0. |
| 6 | Commit a `throw new Error("not implemented")` stub | Pass. Blocked by `stub-pattern-catalog`, exit 1. |
| 7 | Record a decision with a `text_must_match` assertion via `cairn mcp serve` | Pass. Auto-accepted into the ledger. 32 MCP tools listed, matching the README count. |
| 8 | Compliant edit to the in-scope file | Pass. Commits. |
| 9 | Violating edit (TTL 24 h → 7 d) | Pass. Blocked by `decision-assertions`, exit 1. |
| 10 | `git commit --no-verify`, then `cairn sensor-run --diff HEAD~1..HEAD --strict` (the CI command) | Pass. Exit 1 with the same finding. |
| 11 | `cairn mcp call …` (documented in `docs/guide/`) | **Fail.** The subcommand doesn't exist; it prints `mcp serve` usage. Not fixed here (see open findings). |
| 12 | `claude plugin marketplace add isaacriehm/cairn` + `claude plugin install cairn@isaacriehm-cairn` | Pass. v0.33.0 installed and enabled. The bundled `dist/cli.mjs` runs. |
| 13 | SessionStart hook on a fresh unadopted repo (invoked directly) | Pass. Emits the adoption prompt. |
| 14 | `codex plugin marketplace add isaacriehm/cairn` + `codex plugin add cairn@cairn` | Pass. `cairn@cairn` installed and enabled, 0.33.0. |

The first capture of step 7 used a wrongly escaped regex, so the assertion
could never match. The giveaway was step 9 failing even after the file was
restored. That capture was thrown away. The published transcript adds step 8
as the control that proves the gate passes compliant code.

**Not verified:** interactive `cairn init` (needs a TTY and model calls),
in-session adoption through the plugin's adopt skill (model calls), the
Cursor install (no scriptable path), and Codex Desktop.

## What changed, by commit

| Commit | Change |
| --- | --- |
| `73b3fd1` | `chore(meta)`: keywords and `repository.directory` on all five packages. cairn-plugin gets license, author, repository, and bugs. Plain-English descriptions. cairn-core README. |
| `6097889` | `docs(readme)`: README rewrite plus `docs/demo.md`. Adds `cairn join` to the CLI path. Removes the deleted sensor and the nonexistent tool names. |
| `1096139` | `docs`: CONTRIBUTING.md and SECURITY.md. |
| `35601a5` | `chore(github)`: bug and feature issue forms, `config.yml` (blank issues off, routes to Discussions and private advisories), PR template. |
| `fbebfb1` | `docs(changelog)`: missing entries, version-gap note, link references, Unreleased section. |
| (this file) | `docs`: this report. |

### Gates run on the branch

`pnpm install --frozen-lockfile`, `pnpm version:check`, `pnpm build`,
`pnpm typecheck`, `pnpm smokes` (88 smoke scripts), and the three Lens smokes
CI runs. All pass. `pnpm build` produced no diff in the committed plugin
bundle.

`pnpm knip:strict` fails, but it failed identically on `main` before this
branch (3 unused files, 23 unused exports, 54 unused types). It isn't part
of CI or the documented gate. It's listed under open findings and wasn't
loosened.

## Open findings (not fixed here)

These are out of scope for a docs and metadata pass. Each needs its own
change and, where noted, a release.

1. **Dependency advisories.** `pnpm audit --prod`: 29 (3 critical, 9 high).
   The criticals: `simple-git` and `@simple-git/argv-parser`, via the
   direct `simple-git` dependency of `cairn` and `cairn-core`, and
   `proxy-addr`, via `@modelcontextprotocol/sdk`. Highs include `fast-uri`
   and `ip-address`, also via the MCP SDK. The 0.33.0 changelog says the
   production lockfile had no known vulnerabilities. That was presumably
   true then, and the advisories are newer. Fix with version bumps or
   `pnpm-workspace.yaml` overrides, then release.
2. **Dependabot is failing.** Every security-update job since 2026-07-28
   (js-yaml, hono, undici, ip-address, brace-expansion, fast-uri, form-data)
   ends in `update_not_possible`. Root cause not confirmed. The logs show
   pnpm 11.17.0 being resolved, then the file-update step exiting 1. PR #3
   (esbuild 0.28.1, CI green) has been open since June.
3. **`cairn mcp call` is documented but doesn't exist.** 14 occurrences in
   `docs/guide/reference.md` (7), `decisions.md` (4), and `daily-flow.md`
   (3). Either implement it (the demo shows a 15-line client is enough) or
   remove the examples. `cairn_supersedes_chain` is still named in
   `concepts.md` and `decisions.md`.
4. **`cairn init --help` advertises `--skip-mirror`** and a mirror clone
   under `~/.cairn/repos/`. The flag isn't parsed, and the sensor runner
   says there's no mirror checkout anymore.
5. **Statusline shim assumes `~/.claude`.** The SessionStart hook derives
   the plugin slug from `~/.claude/plugins/cache`, so the shim is skipped
   when `CLAUDE_CONFIG_DIR` points elsewhere. Observed in step 13.
6. **`.cairn/.attested-commits` changes after every commit.** The
   post-commit hook appends the new SHA, so the tree is dirty immediately
   after each commit. That may be intentional, but it surprises first-time
   users.
7. **Stale internal docs.** `docs/superpowers/plans/2026-07-26-tri-host-agent-plugin.md`
   has 41 unchecked steps for work that shipped in 0.33.0. The header
   comment in `packages/cairn-core/src/sensors/runner.ts` says the Stop
   hook runs an advisory sweep, but only `cairn sensor-run` calls it.
8. **`AGENTS.md` is public and is the first file an evaluator opens after
   the README.** Its operator profile includes informal and profane notes.
   It also still says to hardcode `haiku`/`sonnet`/`opus` aliases, while
   the 0.33.0 code uses `fast`/`capable` tiers. Whether to keep the profile
   public is the maintainer's call. The tier rule is drift either way.
9. **knip strict fails** (see above).

## What to do on GitHub itself

**About description.** The current one says "for Claude Code" only. Suggested:

> Keeps AI coding agents consistent with your project's recorded decisions. Plugin for Claude Code, Cursor, and Codex, with an MCP server and pre-commit/CI checks.

**Website field.** It's set to the repo's own URL, which is redundant.
Point it at `https://www.npmjs.com/package/@isaacriehm/cairn` or clear it.

**Topics.** Drop five: `multi-agent` (Cairn has no orchestration runtime,
per ARCHITECTURE §6), `anthropic` and `claude` (vendor names, and
`claude-code` already covers them), and `ground-truth` and
`spec-driven-development` (jargon nobody searches for). Add hosts and
mechanisms people do search for:

```bash
gh repo edit isaacriehm/cairn \
  --remove-topic anthropic,multi-agent,ground-truth,claude,spec-driven-development \
  --add-topic cursor,codex,pre-commit,git-hooks,developer-tools
```

That leaves 14 topics: adr, ai-agents, ai-memory, claude-code,
claude-code-plugin, codex, context-engineering, cursor, decision-records,
developer-tools, git-hooks, mcp, mcp-server, pre-commit.

**Social preview.** None is set (GitHub's generated card is in use). Upload a
1280×640 image under Settings → General → Social preview. Use the name, the
one-line headline, and the blocked-commit output from the README example.
That output is the most convincing thing the project has, and it's real.

**Pinned issue.** Open and pin "Known gaps before 1.0" listing open findings
1–6 above, each as a checkbox. It tells evaluators the maintainer knows
where the edges are, and it gives contributors somewhere to start. Label
the smaller ones `good first issue` (3 and 4 fit).

**Discussions** is enabled with zero threads, and the new issue config
routes questions there. Post one short welcome or usage thread, or turn
Discussions off and remove that link.

**Branches.** `pr-4-review` points at the same commit as `main` and can be
deleted.

**When to cut a release.** Not for this branch alone. Metadata and package
READMEs only reach npm on the next publish, but a docs-only release adds
noise. Merge this branch, fix finding 1 (and 2 if it's quick), then cut
`0.33.1` with `pnpm release:patch`. That one release ships the dependency
fixes and the new npm metadata. Move the `[Unreleased]` changelog entries
under `0.33.1` when you do.

## Private-name sweep

The working tree, every commit message and tag annotation on every local
ref, and full history content (`git log -S` across all refs) were searched
for the maintainer-supplied list of client names and private project names.

- **Client names: 0 hits** in the working tree, commit messages, tags, or
  history content.
- **Working tree: 0 hits** for any name on the list.
- **Other hits** were reported to the maintainer directly. This repository
  is public, and per `AGENTS.md` those strings aren't recorded in committed
  files, even in redacted form. History was not rewritten.

## Shipped Oct 6

`credibility-pass` was merged into `main` with a merge commit (`2935904`,
no history rewrite) and pushed. `origin/main` had not moved since
`702a5bf`. Nothing was published to npm, tagged, or released.

### Added before the merge

| Commit | Change |
| --- | --- |
| `f9392cd` | `docs(guide)`: all 14 `cairn mcp call` examples replaced (finding 3). `cairn mcp` only accepts `serve`. Examples now use either the agent calling the MCP tool or the MCP Inspector CLI (`npx -y @modelcontextprotocol/inspector --cli cairn mcp serve --method tools/call ...`). Every new shell block was run verbatim against a scratch adoption built from this tree. The two `cairn_supersedes_chain` calls in `decisions.md` now walk the chain with `cairn_decision_get` and each DEC's `supersedes` field. `daily-flow.md` also claimed `cairn scope --files`, which doesn't exist. That passage now uses `cairn_in_scope`. |
| `9d4733e` | `docs(agents)`: operator-profile rows reworded without profanity or informal phrasing, with the same rules (finding 8). The model rule now matches the code: call sites name a `fast`/`capable` tier, and the transports map it (Claude `haiku`/`sonnet`, Codex `gpt-5.3-codex-spark`, Cursor `auto`). |

### Checks on the merged tree

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `pnpm version:check`, `pnpm build`, `pnpm typecheck` | Pass |
| `pnpm smokes` (88 scripts) | Pass |
| The 10 non-LLM smokes that only `smokes:all` runs | Pass |
| All 5 Lens smokes (CI runs 3) | Pass |
| Working tree after build | Clean |
| `pnpm lint` | **Fail, same on `main`.** No package defines a `lint` script, so `pnpm -r lint` exits 1 before linting anything. The repo has no linter. |
| `pnpm --filter @isaacriehm/cairn check:layout` | **Fail, same on `main`.** 19 hard misses. The script's hardcoded file list still names files that earlier releases removed (for example `mcp/tools/supersedes-chain.ts` and `src/ground/*.ts`). |
| `pnpm knip:strict` | **Fail, output byte-identical to `main`** (3 unused files, 23 unused exports, 54 unused types). |

The two real-model smokes (`smoke:llm-prompt-eval`, `smoke:llm-detect-components`)
were not run. They use model quota, and AGENTS.md limits them to changes
to the Stage-1 prompt or a provider transport. None of the three failing
checks runs in CI, and none was loosened.

### Status of the open findings

- **Fixed:** 3 (`cairn mcp call`) and 8 (`AGENTS.md`).
- **Still open:** 1, 2, 4, 5, 6, 7, and 9.
- **Found during the fix:**
  - `cairn_supersedes_chain` is still named in `docs/guide/concepts.md`.
  - `cairn scope --files` is still listed in `docs/guide/reference.md`, in
    the CLI table and the one-liners. Neither exists.
  - `cairn_record_decision` with `supersedes` writes that field on the new
    DEC, but it never sets `superseded_by` or `status: superseded` on the
    older DEC. On the auto-accept path, the predecessor stays `accepted`.
    `decisions.md` says it is marked on accept.
  - The `lint` and `check:layout` scripts above are broken.

### GitHub settings (not applied)

```bash
gh repo edit isaacriehm/cairn \
  --description "Keeps AI coding agents consistent with your project's recorded decisions. Plugin for Claude Code, Cursor, and Codex, with an MCP server and pre-commit/CI checks." \
  --homepage "https://www.npmjs.com/package/@isaacriehm/cairn" \
  --remove-topic anthropic,multi-agent,ground-truth,claude,spec-driven-development \
  --add-topic cursor,codex,pre-commit,git-hooks,developer-tools
```

The remote branch `pr-4-review` was deleted. It pointed at `702a5bf`, which
is already in `main`.
