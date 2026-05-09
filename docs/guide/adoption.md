# Adopting Cairn

Adoption is the one-time pass that turns an existing project into a
Cairn-managed project. It runs once. Afterwards, Cairn runs invisibly
on every Claude Code session in the repo — the [daily flow](daily-flow.md)
takes over.

This page walks through what actually happens when you adopt, so you
know what to expect, what's automatic, and what you'll be asked to
decide.

---

## Before you start

### Prerequisites

- **Claude Code installed and working.** Cairn is a Claude Code
  plugin; it runs inside a Claude Code session.
- **Project is in git.** Adoption assumes `git` and at least one
  commit. If your repo isn't initialized, the preflight will offer
  to run `git init` for you.
- **A few minutes of attention.** Adoption is fast on small repos
  (~2 minutes) and slower on monorepos (10-15 minutes for
  thousands-of-files codebases). The long-running phases stream
  progress to your status-line so you can leave it running.
- **Node 22+.** The plugin is bundled — no `npm install` required —
  but Node is the runtime.

### What you don't need

- A specific language or framework. Cairn detects stack signatures
  but works on any project (TypeScript, Python, Go, Rust, mixed
  monorepo).
- A specific directory structure. The mapper proposes module
  boundaries from what's actually in your repo.
- An existing `docs/` folder. If you have one, Cairn ingests it.
  If you don't, adoption still works — you'll just have fewer
  initial DEC drafts.
- An MCP host setup. The plugin registers itself; nothing in
  `~/.claude/` to edit by hand.

### What to expect

Roughly:

| Repo profile                | Adoption time |
| --------------------------- | ------------- |
| New repo, ≤ 50 files        | ~2 min        |
| Mid-size, ≤ 500 files       | 3-7 min       |
| Monorepo, 5,000+ files      | 10-20 min     |
| Monorepo with heavy docs    | 15-30 min     |

The long-running phases (3, 7, 8, 9, 10) call Haiku and Sonnet via
the bundled `claude --print` subprocess. You'll see live progress in
the status-line: `⬡ cairn ⏳ adopt 9-source-comments 24/47 (51%) ~3m`.

Adoption is **safe to interrupt**. If you `/exit` mid-phase, the
state persists in `.cairn/init-state.json` and the next session's
SessionStart re-prompts to resume.

---

## Installing the plugin

Three commands inside Claude Code, in any project:

```
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
/reload-plugins
```

What each does:

1. **`/plugin marketplace add isaacriehm/cairn`** — registers the
   GitHub repo as a plugin marketplace. This is a one-time per-machine
   step. After this, Claude Code can discover Cairn (and any future
   sibling plugins from the same repo).
2. **`/plugin install cairn@isaacriehm-cairn`** — installs the plugin
   itself. Pulls the bundled `dist/` from the latest release tag.
   Installs at user level — every project on your machine sees
   Cairn from this point.
3. **`/reload-plugins`** — loads the just-installed plugin into the
   current session. Without this, the SessionStart hook hasn't been
   wired yet and the auto-adopt prompt won't fire.

After this, opening Claude Code in a non-adopted project will offer
the adopt prompt within a few seconds of your first message.

### Disabling Claude Code's built-in auto-memory

Recommended before adoption:

```
/memory → Disable Auto-Memory
```

Why: Cairn is your project's memory layer. Claude Code's built-in
auto-memory writes notes to `.claude/memories/` based on session
heuristics; the two layers conflict (Cairn's DECs say one thing, the
auto-memory note says another, the agent picks one with no obvious
rule). Disabling auto-memory is the cleaner setup.

You can leave auto-memory on if you have a strong reason — Cairn
doesn't refuse to run alongside it — but expect occasional
contradictions to surface in the attention queue.

---

## What you'll see — the 13 phases

Adoption runs as a state machine inside the `cairn-adopt` skill. Each
phase reports a banner before it runs, then either streams progress
or completes silently. Some phases ask one question; the rest are
fully automatic.

A complete phase banner looks like:

```
---
**Phase 9-source-comments** — Haiku classify essay-class JSDoc → DEC + invariant drafts · ~30s / **5-20min**
Haiku classifies every essay-class block comment in scoped source files
(4-way parallel). On busy monorepos this is the longest phase — expect
minutes, not seconds. /exit is safe; SessionStart resumes. Watch the
⏳ indicator on your statusline for live updates.
```

What follows is the phase-by-phase walkthrough.

### Phase 0 — adopt prompt

Your first interaction. The skill renders:

> Adopt this project with Cairn?
> `[a]` yes — walk adoption now (~2-15 min, streamed)
> `[b]` not now — ask again next session
> `[c]` never for this project — mark opted-out

`[a]` continues. `[b]` records a `decline-temp` (re-prompts after 7
days). `[c]` records a `decline-never` and never re-prompts unless
you explicitly run `/cairn-init`.

### Phase 0.5 — status-line wiring (one-time per machine)

If your `~/.claude/settings.json` doesn't have the Cairn status-line
wired yet, adoption offers to add it:

> Cairn's statusline shows live progress during the long adoption
> phases. Wire it into your user-level `~/.claude/settings.json` now?
> `[a]` wire and reopen — patch settings, then /exit and reopen for
>     live progress in this adoption
> `[b]` wire and continue — patch settings now, this adoption runs
>     without live progress (next session sees it)
> `[c]` skip — leave settings alone

`[a]` is recommended for first-time adoption on any repo because
9-source-comments can take 20+ minutes on large monorepos and
without the status-line you'd be staring at a frozen prompt. After
the wire and `/exit`, the next session's SessionStart auto-resumes
adoption — you don't lose state.

### Phase 1 — detect

Probes your environment. Reads `package.json` / `pyproject.toml` /
`Cargo.toml` / `go.mod` to detect language and framework. Looks for
ORM signatures (Drizzle, Prisma, SQLAlchemy), API frameworks
(NestJS, FastAPI, Rails), test frameworks. Outputs a stack
signature used by later phases for sensor proposals and glob
inference.

Visible: a one-line summary like `✓ Detected: TypeScript, NestJS,
Drizzle, Vitest`.

Time: <1s.

### Phase 2 — walker

Walks the repo (`git ls-files`) and builds the file manifest.
Produces extension stats, per-language line counts, top-level
directory inventory.

Visible: tree silhouette with file counts.

Time: <1s on small repos, ~2s on large.

### Phase 3 — mapper

The first LLM phase. Sonnet runs in parallel slices (rounds of 4,
hard cap 50 slices) over your file manifest. Each slice produces a
domain summary and per-module proposals. A Haiku merge synthesizes
the overall `domain_summary` and picks pilot module candidates.

This phase pre-fills `scope_globs` from your detected stack —
NestJS conventions, Drizzle conventions, Rails conventions, etc. —
so most modules get sensible globs without per-project guidance.

Visible: per-module status icons updating live in the status-line.

Time: 30-60s on small repos, 2-4 minutes on large monorepos.

### Phase 3b / 4 — seed

Writes the `.cairn/` skeleton. Creates:

- `.cairn/config.yaml` (slug, version, project_globs)
- `.cairn/config/` (workflow.md, sensors.yaml, stub-patterns.yaml)
- `.cairn/ground/` (decisions/, invariants/, canonical-map/, …)
- `.cairn/git-hooks/` (pre-commit, post-commit, commit-msg)
- `.cairn/.attested-commits` seeded with HEAD-reachable SHAs (so
  pre-adoption history isn't flagged as bypass)

Visible: a one-line "Writing .cairn/ skeleton" then "Grandfathering
N pre-adoption commits into attested set."

Time: <1s.

### Phase 5 — pilot

Operator question: which module gets the deepest treatment?

The mapper proposes 2-3 candidates ranked by signal density. You
pick one. The pilot module gets:

- More aggressive source-comment ingestion (Phase 9 spends extra
  budget on it).
- Higher confidence threshold for bulk-accept.
- First place in the canonical-map seed list.

Pick the module you'd recognize as "the heart" of the project — the
core domain logic, not the build tooling or vendored deps. If you
have one obvious candidate (e.g., `packages/api/src/`), pick it.

> Pilot module — which one is the project's core?
> `[a]` packages/api/src           (largest, most modules)
> `[b]` packages/web/src           (frontend bulk)
> `[c]` packages/billing/src       (most decisions in source comments)

Visible: A/B/C question.

Time: operator-paced.

### Phase 6 — brand

If your repo has authoritative brand/voice/positioning content (in
`docs/brand/`, `BRAND.md`, or a clearly-named root-level doc), this
phase auto-fills the brand DEC drafts using Haiku. You consent
once:

> Auto-fill brand DEC drafts from `docs/brand/overview.md`?
> `[a]` yes      `[b]` skip — I'll fill brand later

If your repo has no brand content, the phase is a no-op and runs
silently.

Visible: A/B/C question (if applicable), then "Generated 3 brand
drafts."

Time: operator + ~30s.

### Phase 7 — topic index

Cross-source dedup pre-pass. Walks every markdown paragraph in
`docs/`, every essay-class source comment block, and every section
of `CLAUDE.md` / `AGENTS.md`. Computes a content fingerprint per
block. Haiku judges semantically-similar pairs above a Jaccard
threshold (5-way parallel, hard cap 200).

Output: a deduplicated topic list so the same fact appearing in
three places doesn't produce three separate DEC drafts.

Visible: live `phase X/Y` updates in status-line.

Time: 30s-2min on small repos, up to 10 minutes on large ones with
heavy docs.

### Phases 8 / 9 / 10 (parallel) — ingest

The three heavy LLM phases run concurrently:

| Phase | What                                                              |
| ----- | ----------------------------------------------------------------- |
| **8 — docs ingest**          | Haiku per `*.md` in `docs/` and `README.md` → canonical-map topics + DEC drafts.   |
| **9 — source comments**      | Walker grabs essay-class JSDoc blocks; Haiku batch classifies as rationale / constraint / citation / license / other; rationale → DEC draft, constraint → INV file. |
| **10 — rules merge**         | Haiku per H2 section in `CLAUDE.md` / `AGENTS.md` / `.claude/rules/*` → DEC drafts; conflicts flagged to `.cairn/ground/conflicts/`. |

These run in parallel because they share DEC + §INV id allocators
(under the same `flock`) and they don't read each other's output —
they only write into ground state.

Visible: per-phase live progress in the status-line. Each phase's
draft count updates as it completes batches.

Time: combined, 1-3 minutes on small repos. **5-20 minutes** on
large monorepos with thousands of source files. Source-comments
(Phase 9) is usually the longest.

You can `/exit` at any point. Resume from `cairn_init_resume` in
the next session.

### Phase 11 — baseline

The first sensor sweep. Runs Layer A / Layer B / Layer C /
Structural sensors against a synthetic full-tree diff (every line
in your repo treated as "newly added"). Findings are written to
`.cairn/baseline/sensor-audit-<timestamp>.yaml`.

Pre-existing violations don't block adoption — they go into the
baseline audit. The CI gate (`--diff origin/main..HEAD`) only checks
each PR's net change, so legacy code isn't penalized.

Visible: per-sensor pass/fail, finding counts.

Time: <1s on small, ~5s on large.

### Phase 12 — strip

Source-comment policy enforcement. Phase 9 detected essay-class
block comments and proposed extractions. This phase walks each
module and asks for consent to strip the original comment and
replace it with a one-line `// §INV-NNNN` citation:

> Module `packages/api/src/auth` has 8 essay-style comment blocks.
> Extracted: 3 DEC drafts, 2 invariants. Diff preview: [collapsible].
> `[a]` strip all (review extractions in _inbox/)
> `[b]` review per-file (escalation)
> `[c]` skip module

Pre-write safety:

- **Uncommitted changes check.** If a file is dirty, you're warned
  before any write — option to stash, skip, or overwrite.
- **Backup.** Every file modified by strip-replace is backed up
  to `.cairn/backups/source/<rel>.original`. `cairn uninstall --full`
  can restore.
- **Diff preview.** You see the proposed diff before it's applied.

Most operators choose `[a]` for non-pilot modules and `[b]` for the
pilot module to read the per-file diffs. If a module has comments
you want to keep verbatim (license headers, complex algorithm
explanations Cairn shouldn't touch), `[c]` skips it.

Visible: per-module batch consent prompts (one A/B/C per module).

Time: operator-paced, typically 5-15 minutes for a thoughtful pass.

### Phase 13 — multidev

Multi-developer enforcement install. Detects your package manager
(`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` →
npm, `pyproject.toml` → poetry/uv, `go.mod` → go). Installs:

- `git config core.hooksPath .cairn/git-hooks` on this clone.
- For Node projects: `package.json` `prepare` script runs `cairn
  join` on `pnpm install`.
- For non-Node projects: emits hints to add equivalent to
  `Makefile` / `justfile` / `pyproject.toml`.
- `JOIN.md` at repo root with bootstrap instructions for new
  contributors.
- `.github/workflows/cairn-check.yml` (if `.github/` exists) for the
  CI gate.

Visible: a final summary of what was installed.

Time: <1s.

---

## The attention drain after adoption

When the pipeline exits, the `cairn-adopt` skill chains immediately
into `cairn-attention`. **This is mandatory** — adoption is not
"done" until you've at least seen the queue. The drafts in
`_inbox/` aren't part of the canonical zone yet; they're proposals.

What you'll see:

1. **Bulk-accept summary.**

   ```
   Auto-accepted 23 obvious DEC drafts. 18 remain for triage
   (11 medium / 7 low). Invariants: 4 high / 2 medium / 1 low —
   all stamped, none auto-promoted.
   ```

2. **Dedup summary** (only if duplicates were detected).

   ```
   Found 3 duplicate clusters across 8 drafts.
     • Definite (≥0.5): 2 clusters, 5 drafts
     • Potential (0.4–0.5): 1 cluster, 3 drafts
   ```

   For each definite cluster, you'll be asked which one to keep.

3. **Conflicts** (only if Phase 10 found contradictions). Each
   conflict surfaces both verbatim sides plus the Haiku judge's
   reasoning — you pick which to keep, merge, or archive both.

4. **Per-item triage** (up to 4 per `AskUserQuestion` panel) for
   medium-confidence drafts. Each draft shows title and rationale.
   Options: `accept` / `reject` / `edit first`.

5. **Browser triage** (only if queue exceeds 15). The skill spawns
   a localhost GUI; you triage in the browser; click "I'm done" to
   resume the chat.

### How to interpret drafts

Some drafts will be obvious keepers — *"We use pnpm for package
management"* — accept. Some will be noise — *"Function should be
named in camelCase"* — reject. Some will be load-bearing and worth
editing — *"Auth tokens expire after 24 hours"* extracted from a doc
that originally said *"24h or less"*; you might tighten the wording
to "exactly 24h" before accepting.

Rejected drafts aren't deleted — they're renamed to
`<id>.rejected.md` so the id stays reserved (never recycled). If you
later realize a rejected DEC was actually correct, you can restore
it by name.

### When you're done

The first attention drain typically takes 10-30 minutes for a
mid-size repo. Don't rush it — these drafts are the project's
recorded knowledge for the next several years. A bad accept means
the agent will quote that text on every future related prompt.

If the queue is too long for one sitting, defer the rest with the
"later" option. The badge will keep pending count visible; resume
in any future session.

---

## What you have when it's done

Concrete inventory after a typical adoption:

```
.cairn/
├── config.yaml                        — slug, version, project_globs
├── config/
│   ├── workflow.md                    — per-task prompt template
│   ├── sensors.yaml                   — sensor registry (with Phase 1 + 11 proposals)
│   └── stub-patterns.yaml             — Layer A catalog (grows via /oops)
├── ground/
│   ├── decisions/
│   │   ├── DEC-0001.md … DEC-0042.md  — accepted decisions (typically 20-80 on first adoption)
│   │   ├── _inbox/                    — remaining drafts (often empty after first drain)
│   │   └── decisions.ledger.yaml      — compact summary, always-loaded at SessionStart
│   ├── invariants/
│   │   ├── INV-0001.md … INV-0019.md  — active invariants (typically 5-25)
│   │   └── invariants.ledger.yaml
│   ├── canonical-map/
│   │   └── topics.yaml                — N entries from Phase 8
│   ├── brand/                         — brand DECs (if Phase 6 ran)
│   ├── conflicts/                     — pending contradictions (often empty)
│   └── scope-index.yaml               — file → DEC/§INV resolution
├── baseline/
│   └── sensor-audit-<ts>.yaml         — Phase 11 audit (one or more files)
├── git-hooks/
│   ├── pre-commit                     — sensor sweep
│   ├── post-commit                    — append SHA to .attested-commits
│   └── commit-msg                     — optional DEC/TSK ref validation
├── backups/source/                    — Phase 12 .original snapshots
├── .attested-commits                  — pre-adoption SHAs grandfathered + ongoing attestations
└── JOIN.md                            — bootstrap doc for new contributors
```

Plus:

- `.github/workflows/cairn-check.yml` (if `.github/` existed) — CI
  gate.
- `package.json` `prepare` script (if Node) — auto-bootstrap on
  install.
- `git config core.hooksPath` set on this clone.

### What the next session will feel like

Open Claude Code in the project the next day. The status-line shows
`⬡ cairn` with current task and pending count. Type a prompt that
implies a code change: `cairn-direction` auto-invokes, loads
in-scope DECs, asks 1-2 clarifying questions, tightens, dispatches.
You don't see the SessionStart context block — it's in the system
prompt — but the agent is now reading it on every reply.

Sensor sweeps run on commit. The reviewer fires on multi-chunk
tasks. The status-line tracks live state.

You may notice the system "knows" things it didn't before:

- It cites `DEC-0042` when refusing to extend a token's lifetime.
- It uses the path `cairn_canonical_for_topic` returned instead of
  guessing.
- It asks better clarifying questions because the in-scope context
  is loaded.

This is the daily flow. See [`daily-flow.md`](daily-flow.md) for
the full breakdown.

---

## If adoption fails mid-way

Adoption is designed to be safe to interrupt. Three failure modes:

### `/exit` mid-phase

Safe. Phase state persists to `.cairn/init-state.json` after every
successful phase return. The next session's SessionStart hook
detects the in-flight init and re-invokes `cairn-adopt`, which calls
`cairn_init_resume` to pick up at the same `currentPhase`.

The rare case where an exit is unsafe is during the strip-replace
write itself (Phase 12) — the file write is wrapped in a backup-then-
write but you could in theory catch it mid-write. In practice this
hasn't happened; the writes are small and atomic.

### A phase errors

When a phase tool returns `{ status: "error", error: {...} }`, the
skill surfaces the error and asks:

> Phase 9 errored: `Haiku call failed: rate_limit`
> `[a]` retry phase
> `[b]` abort

`[a]` re-runs from the same `currentPhase` (the on-disk state isn't
clobbered by the error path). `[b]` ends the turn; resume later via
the next session's auto-prompt.

Common errors:

| Error                          | Likely cause                              | Fix                                  |
| ------------------------------ | ----------------------------------------- | ------------------------------------ |
| `Haiku call failed: rate_limit` | Hit the per-minute quota                  | Wait 60s, retry                      |
| `git status not clean`         | Phase 12 detected uncommitted changes     | Commit or stash, retry               |
| `EACCES on .cairn/ground/`     | Permission issue                          | `chmod -R u+w .cairn/`, retry        |
| `Walker timeout`               | Repo larger than expected                 | Increase the per-phase timeout (rare) |

If retry doesn't resolve and abort doesn't help either, file an
issue with the trace excerpt:

```bash
cairn trace --errors-only --tail 50
```

### Something looks wrong post-adoption

Sometimes adoption completes but the result looks off — too few
DECs, missing canonical entries, weird globs. Diagnostic steps:

1. **`cairn doctor`** — runs the standard health checks. If the
   ledgers are empty or the scope-index is missing entries, it'll
   surface them.
2. **Check `.cairn/init-state.json`** — has all 13 phases as
   completed?
3. **Inspect `.cairn/baseline/sensor-audit-*.yaml`** — what did
   Phase 11 find?
4. **Re-run individual phases.** Adoption is idempotent; you can
   re-run a phase by deleting its entry from
   `.cairn/init-state.json` and calling
   `cairn_init_resume`. (This is a power-user move; in most cases,
   what looks wrong is just a sparser ground state than you
   expected because your project doesn't have a lot of inline
   rationale — that's fine.)

### Total reset

If adoption produced something you don't want and you'd rather
start clean:

```bash
cairn uninstall --full
```

This restores stripped source comments from `.cairn/backups/source/`,
removes `.cairn/`, removes the git hooks, and removes `JOIN.md`. It
asks for confirmation: *"this is irreversible. proceed?"*. After
that, the project is back to its pre-adoption state.

`cairn uninstall` (without `--full`) is the lighter option: stops
enforcement (removes `core.hooksPath`, removes the CI gate, removes
the package.json `prepare` entry) but leaves `.cairn/` intact. You
can re-enable later via `cairn join` or by re-installing the plugin.

---

## What to read next

- [`daily-flow.md`](daily-flow.md) — what every session looks like
  after adoption.
- [`decisions.md`](decisions.md) — DEC creation, scope design, the
  supersedes chain in depth.
- [`multi-dev.md`](multi-dev.md) — onboarding a second developer to
  the adopted repo.
