# Cairn for teams

Cairn was designed solo-first but works fine for small teams. The
extra concern with teams is enforcement: once a project is adopted,
every contributor needs to be running Cairn — locally and at PR time
— or the recorded decisions stop being load-bearing. A second
developer on the project who isn't running Cairn can silently drift
the codebase from the ground state.

This page covers what Phase 13 (multi-dev install) sets up, how
contributors onboard, the CI gate, and bypass detection.

---

## What Phase 13 installs

The final phase of adoption (`13-multidev`) wires the multi-developer
enforcement layer. Concretely, it installs:

1. **Versioned git hooks** at `.cairn/git-hooks/`:
   - `pre-commit` — runs the sensor sweep on the staged diff.
   - `post-commit` — appends the new SHA to `.cairn/.attested-commits`.
   - `commit-msg` — optional validation of `DEC-<hash>` / `TSK-NNNN`
     references in commit messages.
2. **`core.hooksPath`** set on this clone:
   ```
   git config core.hooksPath .cairn/git-hooks
   ```
   Per-clone (lives in `.git/config`, which isn't versioned), so it
   must be set on every clone via the bootstrap step.
3. **`JOIN.md`** at repo root — the bootstrap doc for new
   contributors.
4. **CI gate** at `.github/workflows/cairn-check.yml` (if `.github/`
   exists). For non-GitHub hosts, the phase emits hints for GitLab /
   Bitbucket equivalents.
5. **Package-manager `prepare` hook** — for Node projects, adds to
   `package.json`:
   ```json
   { "scripts": { "prepare": "cairn join || true" } }
   ```
   Runs on every `npm install` / `pnpm install` / `yarn install`,
   making bootstrap automatic for new contributors who clone and
   install. The `|| true` fails soft so a missing Cairn during install
   doesn't break the install — the failure surfaces at first commit
   instead.

   For Python (poetry, uv), Go, Rust, the phase emits equivalent hints
   (`Makefile` target, `justfile` recipe, `pyproject.toml` script) for
   you to wire as appropriate to your build flow.

---

## Onboarding a new developer

The new contributor's flow:

1. Clones the repo.
2. Runs `pnpm install` (or `npm install` / `yarn install` for Node;
   for non-Node, runs the `make` / `just` target the project uses).
3. The `prepare` script runs `cairn join`, which:
   - Verifies the Cairn CLI is on PATH (or surfaces install
     instructions if not).
   - Sets `git config core.hooksPath .cairn/git-hooks` on the clone.
   - Confirms version compatibility between local CLI and project
     state.
   - Idempotent — safe to re-run.

That's it. From this point, the contributor's git workflow is
gated by the same hooks as the original adopter.

### When `cairn join` finds Cairn isn't installed

```
✗ Cairn CLI not on PATH

This project uses Cairn. Install:

  Claude Code plugin:
    /plugin marketplace add isaacriehm/cairn
    /plugin install cairn@isaacriehm-cairn
    /reload-plugins

  CLI only (if you don't use Claude Code):
    npm install -g @isaacriehm/cairn

After installing, run `cairn join` from this clone, or just
re-run `pnpm install`.

This project will not let you commit until Cairn is installed.
```

The new contributor installs Cairn (either form), then re-runs the
install or `cairn join` directly. Subsequent commits go through the
sensor sweep.

### What happens if they skip the bootstrap

Two layers catch this:

1. **Plugin degraded mode.** If they open the project in Claude Code
   with the Cairn plugin enabled but `core.hooksPath` is unset, the
   SessionStart hook detects it and surfaces:
   ```
   This project uses Cairn, but your clone isn't bootstrapped. Without
   it, your commits will fail.

   [a] bootstrap now (one-time, ~5s)
   [b] skip (commits will fail until you bootstrap)
   ```
   The MCP write tools refuse with `BOOTSTRAP_REQUIRED` until
   bootstrap completes.
2. **Pre-commit failure.** If they bypass the plugin entirely (use
   git from the terminal without ever opening Claude Code), the
   first `git commit` fails because `core.hooksPath` is unset and
   the project's pre-commit hook never ran:
   ```
   ✗ Pre-commit hook missing.
     This project requires Cairn. Run `cairn join` to bootstrap.
   ```

Both paths surface the same fix: run `cairn join`.

### What `JOIN.md` looks like

Adoption writes a self-contained doc at the repo root. Sample content:

```markdown
# Joining this project

This project uses [Cairn](https://github.com/isaacriehm/cairn) for
shared architectural state. Before your first commit, bootstrap your
clone.

## One-time setup

Install Cairn:

```bash
# Option A: Claude Code plugin (recommended)
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
/reload-plugins

# Option B: CLI only
npm install -g @isaacriehm/cairn
```

Bootstrap your clone:

```bash
cairn join
```

This sets `core.hooksPath` so the project's versioned git hooks run
on every commit.

## What this enables

- The pre-commit hook runs sensors against your staged diff.
- The CI gate (`.github/workflows/cairn-check.yml`) verifies on PR.
- Recorded decisions in `.cairn/ground/decisions/` are loaded into
  every Claude Code session you run in this project.

If you're new to Cairn, read the [user guide](docs/guide/concepts.md)
or the [README](README.md).
```

You can edit this file freely — it's just markdown — but adoption
regenerates it on `cairn doctor --fix` if it's missing.

---

## The CI gate

The CI gate is the canonical enforcement layer. Local hooks are
conveniences (fail fast, surface findings inline); CI is the
contract.

### What the workflow does

`.github/workflows/cairn-check.yml`:

```yaml
name: cairn-check
on: [pull_request, push]
jobs:
  cairn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0      # full history for diff vs main
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install -g @isaacriehm/cairn
      - run: cairn sensor-run --diff origin/main..HEAD --strict
```

Runs on every push and every PR. Fails the workflow if:

- Any sensor returns hard fail.
- Any required attestation is missing for changed code.
- Any decision-assertion fails on the PR's net change.

### Why it can't be bypassed

`git commit --no-verify` bypasses the local pre-commit hook. The CI
gate runs server-side on the PR; there's no `--no-verify` available
for it. So even if a developer pushed a commit that locally skipped
the gate, the CI workflow blocks the merge.

This is the contract: **what's recorded is enforced, period.** A
contributor can choose to bypass locally for legitimate reasons
(quick fix, hot patch, sensor catalog incomplete), but the merge
won't land without addressing the underlying issue.

### What a failing CI gate looks like

```
✗ cairn-check / cairn

  Layer A (stub catalog) — 1 hit
     packages/billing/src/refund.ts:47
       pattern: throw new Error('not implemented')

  Layer C (decision-assertions) — 1 fail
     DEC-a3f7b2c a1: text_must_match
       expected pattern: expiresIn:\s*'24h'
       in_globs: src/auth/jwt.ts
       result: pattern not found

✗ Failing 2 sensors. Fix and push again.
```

The PR shows the failed check; the developer addresses the findings
locally and pushes a fix.

### When CI is the only gate

Some teams disable local hooks intentionally — fewer interruptions
during exploratory work. That's fine: the CI gate covers correctness
at PR time. The cost is slower feedback (you find out at PR rather
than commit).

If you want to disable local hooks but keep CI:

```bash
git config --unset core.hooksPath
```

The pre-commit gate is gone; pre-merge gate stays.

---

## Bypass detection

Even with local hooks installed, a developer can run
`git commit --no-verify` to skip them. The bypass-detection layer
ensures these commits don't quietly accumulate.

### How it works

Two hooks coordinate:

1. **`post-commit`** — when the pre-commit hook completes
   successfully, the post-commit hook appends the new commit SHA to
   `.cairn/.attested-commits`:
   ```
   .cairn/.attested-commits
   ─────────────────────────
   7f3a2c1
   abc1234
   def5678
   ...
   ```
   This file is gitignored — per-clone, not shared.
2. **Stop hook** — at the end of every Claude Code assistant turn,
   the hook diffs your recent **local, unpushed** commits against
   `.cairn/.attested-commits`. Any such commit not in the file is a
   bypass candidate (the pre-commit hook was skipped, e.g.
   `--no-verify`).

   Only unpushed commits are inspected (`git log HEAD --not
   --remotes`). `.attested-commits` is per-clone, so a teammate's
   commit pulled into your clone would otherwise look unattested —
   but it already lives on the remote and was gated by CI, so it is
   excluded. You are only ever asked about your own ungated local
   work. (Solo repos with no remote inspect recent HEAD as before.)

### What surfaces

```
Commit `abc1234` ("fix: quick token bump") was not attested by Cairn
(likely `git commit --no-verify`).

[a] backfill — run sensors on this commit now, accept findings
[b] accept   — record as DEC: "intentional bypass — reason?"
[c] defer    — don't surface again this session
```

- **`[a]` backfill** runs the full sensor sweep against the commit's
  diff. If clean, the SHA is added to `.attested-commits` and the
  bypass is resolved. If sensors fail, you triage the findings.
- **`[b]` accept** records the bypass as a deliberate choice — useful
  when the bypass was for a known reason (sensor catalog didn't yet
  cover this case, hotfix needed before catalog update). The DEC
  captures the rationale so future audits understand why this commit
  was outside the gate.
- **`[c]` defer** keeps the surface for next session. Useful when you
  want to think about it before deciding.

### Why this matters for teams

Without bypass detection, `--no-verify` is invisible. A team where
half the developers use it casually has no record of which commits
were gated and which weren't, which corrupts the auditability of the
recorded decisions.

With bypass detection, every commit either:
- Went through the gate (in `.attested-commits`), or
- Was acknowledged as a bypass (recorded as a DEC with rationale).

There's no third state. The audit trail stays intact.

### Pre-adoption commits

When you adopt Cairn, your existing git history hasn't been gated.
Phase 3b (seed) grandfathers all HEAD-reachable SHAs at adoption
time into `.attested-commits`. So the bypass detector starts from a
clean slate at adoption — only post-adoption commits are subject to
the check.

This is also why the CI gate uses `--diff origin/main..HEAD`: it
checks each PR's net change, not the entire prior history. Existing
violations don't block; new ones do.

---

## Sharing decisions

DECs and §INVs live in `.cairn/ground/decisions/` and
`.cairn/ground/invariants/`. Both are version-controlled — they
commit with the rest of your code. So when one developer accepts a
DEC, it's part of the next git push, and other developers see it on
the next pull.

### What gets committed

The rule is **commit sources, gitignore derivations.** The committed
side is the source of truth contributors share; everything Cairn can
regenerate from it is per-clone.

| Path                                          | Status         |
| --------------------------------------------- | -------------- |
| `.cairn/config.yaml`, `.cairn/config/`        | committed (source) |
| `.cairn/ground/decisions/DEC-*.md`            | committed (source) |
| `.cairn/ground/invariants/INV-*.md`           | committed (source) |
| `.cairn/ground/.archive/`                     | committed (retired-entity history) |
| `.cairn/ground/canonical-map/`                | committed (curated) |
| `.cairn/ground/brand/`, `.cairn/ground/product/` | committed (curated) |
| `.cairn/git-hooks/`                           | committed      |
| `.cairn/JOIN.md`                              | committed      |
| `.cairn/ground/manifest.yaml`                 | **gitignored** (derived) |
| `.cairn/ground/scope-index.yaml`              | **gitignored** (derived) |
| `.cairn/ground/quality-grades.yaml`           | **gitignored** (derived) |
| `.cairn/ground/decisions/decisions.ledger.yaml` | **gitignored** (derived) |
| `.cairn/ground/invariants/invariants.ledger.yaml` | **gitignored** (derived) |
| `.cairn/ground/topic-index.yaml`              | **gitignored** (derived) |
| `.cairn/ground/anchor-map.yaml`               | **gitignored** (derived) |
| `.cairn/ground/sot-cache.yaml`                | **gitignored** (derived) |
| `.cairn/ground/sot-bindings.yaml`             | **gitignored** (derived) |
| `.cairn/ground/file-candidates-map.yaml`      | **gitignored** (derived) |
| `.cairn/ground/alignment-pending/`            | **gitignored** (per-clone queue) |
| `.cairn/ground/decisions/_inbox/`             | **gitignored** |
| `.cairn/sessions/`, `.cairn/runs/`            | **gitignored** |
| `.cairn/staleness/`, `.cairn/baseline/`       | **gitignored** |
| `.cairn/state/align-undo-log.jsonl`, `.cairn/state/fix-align-dryrun.json` | **gitignored** (per-clone) |
| `.cairn/.attested-commits`                    | **gitignored** |

The derived files (indexes, ledgers, caches) are rebuilt from the
committed DEC/INV `.md` sources — which carry the load-bearing
`sot_kind` / `sot_path` / `sot_content_hash` frontmatter — by
`rebuildDerived`, run on `cairn join` and on every SessionStart.

### Merge conflicts

Effectively none on Cairn state, by design. The two sides:

- **Sources** (`DEC-*.md`, `INV-*.md`) are content-addressed —
  the server allocates each id from a hash under the `flock`, so two
  developers recording decisions concurrently get distinct files, not
  a collision. The realistic case is two people editing the same DEC
  body before accepting; that is standard markdown git merge.
- **Derived files** used to be committed and were the real conflict
  source — every clone rewrote them locally (timestamps, content
  hashes, token caches) and pushed divergent copies, so `push` /
  `pull` collided on machine-generated YAML. As of v0.15.0 they are
  gitignored and never committed, so the conflict surface is gone.

If you adopted Cairn before v0.15.0, the derived files are still
tracked in your repo. Untrack them once (one developer, one commit):

```bash
cairn fix gitignore
git add .cairn/.gitignore
git commit -m "cairn: untrack derived ground state (v0.15.0)"
```

This rewrites `.cairn/.gitignore` from the bundled template and
`git rm --cached` the now-ignored paths. Teammates pick it up on the
next pull; their next `cairn join` / SessionStart rebuilds the files
locally. Never hand-edit a derived file — it is regenerated on every
session.

### Pulling new decisions

When another developer pushes new DECs, your next `git pull`
brings them in. The next time you open Claude Code in the project,
SessionStart rebuilds the ledgers and your scope queries see the
new DECs.

If you're mid-session when the pull happens and want to refresh
without restarting:

```
cairn doctor --refresh-ledgers
```

### Reviewing other developers' DECs in PRs

Decisions in a PR show up as new files under
`.cairn/ground/decisions/`. The PR review reads like any markdown
review — frontmatter, body, scope. Common review questions:

- Is the title specific?
- Is the rationale clear about *why this and not the alternative*?
- Is the scope correct (not too narrow, not too broad)?
- Does it conflict with an existing DEC? (If yes, should it
  supersede that DEC explicitly?)

A team where every PR with new DECs gets the DECs reviewed as
deliberately as the code is a team where the recorded knowledge
stays high-quality.

---

## Failure modes and how Cairn handles them

A few realistic team scenarios.

### A new developer commits without bootstrapping

Caught at:

1. **Plugin degraded mode** if they use Claude Code (banner +
   blocked write tools).
2. **Pre-commit failure** if they use git directly (hooks not
   wired, hook absent, commit fails).
3. **CI gate** as the final backstop — sensors run server-side on
   the PR.

Cost of skipping bootstrap is high enough that it doesn't happen
twice.

### A developer uses `--no-verify` repeatedly

Caught at:

1. **Stop hook bypass detection** — every unattested HEAD commit
   surfaces in the next session.
2. **CI gate** — sensors run on the PR regardless of local bypass.

You get visibility into the pattern. Most teams find one or two
developers occasionally bypassing for legitimate reasons (quick
hotfixes); a developer bypassing daily is a separate conversation
about whether the gate's threshold is right.

### A developer manually edits a DEC body

Allowed but flagged. The next SessionStart's ledger rebuild detects
the frontmatter changed and bumps `verified-at`. If the change is
substantive (changes the rationale), best practice is to write a
superseder instead — the change is recorded as an explicit revision
rather than a silent edit.

The exception: typo fixes, formatting, scope-glob corrections that
don't change the meaning. Those are fine to edit in place.

### A developer deletes a DEC file

The ledger rebuild on next SessionStart removes the entry. No
audit trail of why it was deleted. Recommend instead:
`cairn_archive` to move the DEC to `.archive/` with a deletion
reason recorded in archive metadata. The deletion is then
queryable via `cairn_query_history`.

### Two developers race on the same DEC id

Cannot happen. The MCP server allocates DEC ids under
`.cairn/.write-lock` (per-write `flock`). Even if both clones call
`cairn_record_decision` at the same millisecond, the lock
serializes them and they get distinct ids. The first to land
in their commit wins the lower id; the second's id is the next
sequence. Both DECs are valid — they're about different choices,
they just happened to be drafted concurrently.

### A team-wide decision needs to be communicated outside chat

DECs aren't a substitute for changelogs or team meetings. When a
load-bearing DEC lands (e.g., the token-lifetime escalation),
announce it the way you'd announce any architectural change —
release notes, changelog entry, Slack post. The DEC is the
canonical record; the announcement is the heads-up.

---

## When a team is too big for Cairn

Cairn is calibrated for solo founders and small teams (≤ ~10
contributors). At that scale, the operator-driven decision review
is fast and the queue stays drainable.

At larger scale, a few patterns start to bend:

- **Attention queue grows faster than triage.** With 30+ contributors
  pushing work daily, the reviewer subagent generates more drafts
  than any one operator can triage. A team-wide attention rotation
  helps but there's no built-in support for it (yet).
- **Conflict resolution is operator-paced.** Phase 10 conflict
  prompts are designed for single-operator review; in a large team,
  you may want a team-wide vote rather than the first reviewer's
  call.
- **The `team` collaboration mode** (set in
  `.cairn/config/workflow.md`) opens PRs against `main` from
  per-run branches and gates merges on CI, which is more compatible
  with code review at scale than the default `solo` direct-commit
  mode. See `docs/FILESYSTEM_LAYOUT.md` §12 for the spec.

For very large teams, the unit of adoption is probably "one team's
service" rather than "the whole monorepo" — you adopt the auth
team's repo, the billing team's repo, etc., with each team's
operator owning their own queue.

---

## What to read next

- [`adoption.md`](adoption.md) — the one-time install per project.
- [`reference.md`](reference.md) — fast lookups for CLI commands
  and MCP tools.
- [`../PLUGIN_ARCHITECTURE.md`](../PLUGIN_ARCHITECTURE.md) §17 — the
  full multi-dev enforcement spec.
