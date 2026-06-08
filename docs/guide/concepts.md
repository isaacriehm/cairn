# Core concepts

This is the conceptual map. Read it once and the rest of the guides
read cleanly. Every concept here has a concrete example because the
abstractions on their own do not pay rent.

The premise: AI coding agents have no memory of what your project has
already decided. Every session starts cold. A bigger context window
delays the failure but doesn't fix it. Cairn fixes it by storing the
load-bearing knowledge — decisions, hard rules, file locations — on
disk in a format the agent reads on every prompt and writes to when
new decisions surface in the diff.

There are seven concepts. They compose:

| Concept              | One line                                                          |
| -------------------- | ----------------------------------------------------------------- |
| **Decision (DEC)**   | An architectural choice with a reason, scope, and supersedes chain. |
| **Invariant (§INV)** | A hard rule whose violation is always a bug.                      |
| **Canonical map**    | `topic → file` index so the agent doesn't grep blindly.           |
| **Scope**            | The file glob a DEC or §INV applies to.                           |
| **Attention queue**  | The pile of pending DEC drafts and findings waiting for review.   |
| **Sensors**          | Mechanical checks that run on every diff.                         |
| **Drift**            | When code or docs disagree with what's recorded in `.cairn/`.     |

---

## 1. Decisions (`DEC-<hash>`)

A decision is a markdown file that records one architectural choice
the project has made, the reason for the choice, the files the choice
applies to, and (when it replaces an earlier choice) a pointer back to
the decision it superseded.

Decisions live in `.cairn/ground/decisions/`. Each accepted decision
gets a numbered file:

```
.cairn/ground/decisions/
├── DEC-3f2a1b8.md
├── DEC-7c2f10a.md
├── DEC-a3f7b2c.md
├── _inbox/
│   └── DEC-b1e9c04.draft.md       # awaiting accept/reject
└── decisions.ledger.yaml       # compact summary, always-loaded
```

### What a decision file looks like

Here is `DEC-a3f7b2c.md` after acceptance:

```markdown
---
id: DEC-a3f7b2c
title: Auth tokens expire after 24 hours
status: accepted
audience: dual
generated: 2026-04-12T18:23:00Z
verified-at: 2026-05-01T18:23:00Z
decided_at: 2026-04-12
decided_by: operator
scope_globs:
  - src/auth/**
  - packages/api/src/middleware/auth/**
supersedes: DEC-7c2f10a
superseded_by: null
related_invariants: [INV-a3f7b2c]
---

# DEC-a3f7b2c — Auth tokens expire after 24 hours

## Context

PCI compliance audit (Q1 2026) flagged our prior 7-day refresh window
as out of policy for cardholder-data scope. Short-lived bearer tokens
with refresh-on-active-session is the agreed remediation.

## Decision

All bearer tokens issued by `src/auth/` expire 24 hours after issue.
Refresh tokens follow the same lifetime. Sessions that need longer
lifetime use the silent-refresh middleware in
`packages/api/src/middleware/auth/silent-refresh.ts`.

## Consequences

- Mobile clients: must implement silent-refresh or re-prompt for login
  daily.
- Service-to-service: use the `service-account` flow which has its own
  90-day rotation policy (covered by DEC-d4e6a92).
- Old test fixtures with 7-day token lifetimes need updating —
  baseline scan flagged 14 files.
```

### Why decisions matter

The agent reads the in-scope decisions before touching any file in the
scope. So when you open a Friday session and prompt *"clean up the
auth refresh logic"*, the agent loads `DEC-a3f7b2c` automatically and
sees the 24-hour rule before writing any code. It can no longer
silently roll the lifetime back to 7 days because the constraint
exists in its working context.

This is the core failure mode Cairn fixes. Without a recorded
decision, the model has no way to know that the 24-hour expiry was a
deliberate choice. With one, the choice is part of the prompt.

### How decisions get created

Three paths, in order of how often you'll see each:

1. **Adoption ingestion.** When you first run adoption, the pipeline
   reads your `docs/`, your source-comment essays, and your
   `CLAUDE.md` / `AGENTS.md` and proposes DEC drafts for every
   architectural choice it finds. Most projects produce 20–80 drafts
   on first adoption. You triage them in the attention queue.
2. **Reviewer subagent.** After every multi-chunk task, the reviewer
   subagent reads the diff and looks for non-obvious choices the
   implementation made — say, picking `bcrypt` over `argon2id` for a
   new password-hashing path. It drafts a DEC and the stop hook
   surfaces it inline.
3. **Manually, via `cairn_record_decision`.** When you're about to
   make a load-bearing call and want it recorded before the agent
   acts, drop a DEC explicitly. The MCP tool derives a content-addressed
   `DEC-<hash>` id and writes a draft to `_inbox/`. You accept it, and the
   next time anything touches the scoped files, the agent reads it.

### Scope: what `scope_globs` means

`scope_globs` is the file glob that binds the decision to code. The
agent's `cairn_in_scope` query takes a list of paths (the
files about to be touched in this task) and returns only the
decisions whose `scope_globs` overlap.

For `DEC-a3f7b2c` the scope is:

```yaml
scope_globs:
  - src/auth/**
  - packages/api/src/middleware/auth/**
```

So a task that touches `src/auth/jwt.ts` loads the DEC. A task that
touches `src/billing/checkout.ts` does not — the decision isn't
relevant, and loading it would just add noise to the spec.

Scope design is its own discipline; `decisions.md` covers it in
depth. The short version: too narrow and the agent misses context;
too broad and irrelevant DECs pollute every task.

### The supersedes chain

Decisions are append-only. You never edit an accepted DEC in place.
When the project changes its mind, you write a new DEC that
supersedes the old one:

```markdown
---
id: DEC-b1e9c04
title: Auth tokens expire after 8 hours (PCI Level 1)
status: accepted
supersedes: DEC-a3f7b2c
...
---
```

`DEC-a3f7b2c.md` then gets `superseded_by: DEC-b1e9c04` written into its
frontmatter, but the file stays. The chain is queryable:

```bash
cairn_supersedes_chain({ decision_id: "DEC-a3f7b2c" })
# returns:
# [
#   { id: "DEC-7c2f10a", status: "superseded", supersedes: null },
#   { id: "DEC-a3f7b2c", status: "superseded", supersedes: "DEC-7c2f10a" },
#   { id: "DEC-b1e9c04", status: "accepted",   supersedes: "DEC-a3f7b2c" }
# ]
```

This means you can always reconstruct *why the architecture evolved*.
Six months from now when someone asks "why is the token lifetime so
short?", the answer is the chain: DEC-7c2f10a (7-day refresh) →
DEC-a3f7b2c (24h, PCI compliance) → DEC-b1e9c04 (8h, escalated to Level 1).

The agent reads only the active link in the chain when planning new
work, but the history stays accessible for audit and onboarding.

---

## 2. Invariants (`§INV-<hash>`)

An invariant is a domain rule whose violation is **always a bug**, not
a style preference and not an architectural choice that could
reasonably go either way.

The mental test: if a new contributor writes code that breaks a
decision, you'd say *"that's not how we decided to do it — let's
discuss."* If they break an invariant, you'd say *"that's a bug, fix
it."*

Examples:

```
§INV-a3f7b2c — All API responses include an `x-request-id` header.
§INV-9b0f3a7 — No direct database access outside src/db/.
§INV-2e7c4d1 — Refund operations must be idempotent (same idempotency-key
            returns the same result).
§INV-0104 — User input is sanitized before reaching any HTML render path.
```

Each invariant is a markdown file in `.cairn/ground/invariants/`:

```yaml
---
id: INV-a3f7b2c
title: All API responses include x-request-id header
type: invariant
status: active
audience: dual
source-decision: DEC-d4e6a92
sensor: cairn/scripts/check-inv0042-request-id.ts
e2e: e2e/INV-a3f7b2c_request_id_header.spec.ts
---

# §INV-a3f7b2c — All API responses include x-request-id header

## Why

Distributed-tracing correlation. Without this header, a user-reported
bug at the frontend can't be matched to backend logs. The header is
generated by the request-context middleware and propagated through
every response writer, including error paths.

## Scope

All HTTP routes under `packages/api/src/routes/**`. Excluded: the
health check at `/healthz` and the static asset server.
```

### Decisions vs invariants — the practical difference

| Aspect            | Decision (DEC)                                      | Invariant (§INV)                                       |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------ |
| Hardness          | A choice with reasoning. Could change.              | A hard rule. Violations are bugs.                      |
| Failure mode      | Drift = future code disagrees with rationale.       | Drift = production bug.                                |
| Enforcement       | Loaded into agent context so it's honored.          | Loaded into context **and** enforced by sensors.       |
| Citation in code  | Rare. The DEC is the rationale, not the rule.       | Common: `// §INV-a3f7b2c` next to the relevant line.      |
| Supersedes chain  | Yes — replaced via new DEC.                          | Rarely replaced, but not eternal — an INV whose source is refactored away is auto-retired (archived) by the `entity-orphan` GC pass. |

In source code, only invariants get inline citations:

```ts
// §INV-a3f7b2c
res.setHeader('x-request-id', ctx.requestId);
```

The `§INV-a3f7b2c` token is recognized by Cairn Lens (the editor
extension) which renders the invariant title and body on hover. The
strip-replace pass during adoption inserts these citations
automatically when essay-style comments map to a known invariant; you
can also add them by hand.

### How invariants get created

- **Adoption ingestion (Phase 9).** When the source-comment classifier
  reads an essay-style block comment and decides it's expressing a
  hard rule rather than a rationale, it writes an `INV-<hash>.md` with
  status `active` directly. (Invariants don't go through the draft
  inbox the way DECs do — adoption seeds them straight into ground
  state because their detection threshold is conservative.)
- **By hand.** Add a markdown file to `.cairn/ground/invariants/` with
  the standard frontmatter, then re-trigger ledger rebuild via
  `cairn doctor` or just open a new session (SessionStart rebuilds the
  invariants ledger).

### Why sensors matter for invariants

Decisions live in the agent's working context but aren't checked
mechanically. An invariant gets the same context loading **plus** a
sensor — a script that scans the diff for violations. So if the agent
forgets and writes a route handler that doesn't set `x-request-id`,
the pre-commit sensor catches it before the commit lands.

See section 6 for how sensors work.

---

## 3. The canonical map

The canonical map is a curated `topic → file` index. It exists because
agents are bad at knowing where things live. Without it, asked *"how
does rate limiting work in this project?"* the agent will grep for
"rate limit" and may or may not find the right file. With it, the
agent runs:

```
cairn_canonical_for_topic({ topic: "rate limiting" })
```

and gets back:

```json
{
  "topic": "rate limiting",
  "canonical_path": "packages/api/src/middleware/rate-limit.ts",
  "sha256": "9e3f4a2c...",
  "verified_at": "2026-05-02T03:00:00Z",
  "audience": "dual"
}
```

A real, current path. Not a guess.

### Where the topics come from

Adoption Phase 8 (docs ingest) reads every doc in `docs/` and
proposes canonical-map entries for the authoritative ones. Phase 9
(source comments) does the same when it finds a source file
explicitly described as "the place where X happens." Phase 10 (rules
merge) catches the rest from your `CLAUDE.md` / `AGENTS.md`.

You can also add entries by hand — `cairn_canonical_for_topic` is
read-only, but the underlying file is `.cairn/ground/canonical-map/topics.yaml`
and you can edit it directly:

```yaml
topics:
  - name: rate limiting
    path: packages/api/src/middleware/rate-limit.ts
    audience: dual
  - name: payment processing
    path: src/services/stripe/index.ts
    audience: dual
  - name: email templates
    path: packages/email/templates/
    audience: dual
```

### What the canonical map prevents

Two failure modes. First, the agent inventing a path that sounds
right but doesn't exist (`src/utils/rate-limiter.ts` when the actual
file is `packages/api/src/middleware/rate-limit.ts`). Second, the
agent finding *a* rate-limiting file (some legacy stub at
`src/legacy/throttle.ts`) and assuming it's the canonical one.

A topic is not a tag — it's the *single* answer to "where does X
live?" If a project has two rate limiters by design, the topic is
`rate limiting (api)` vs `rate limiting (worker)`, with two distinct
entries.

### When to add a topic

Add one when:

- The location is non-obvious and you've explained it more than once.
- An agent has fabricated a wrong path for the same topic twice.
- A new contributor would have to grep for it.

Don't add one when:

- The location is obvious from the project's directory naming
  conventions (`src/auth/` clearly contains auth — no need for a
  topic).
- The "topic" is really a piece of API surface, not a place
  (`canEditUser` is a function, not a topic).

---

## 4. Scope

Scope is how decisions and invariants bind to code. Without scope
they'd be free-floating rules; with scope they're triggered only when
relevant.

Every DEC and §INV declares a `scope_globs`:

```yaml
scope_globs:
  - src/auth/**
  - packages/api/src/middleware/auth/**
```

When the agent (or you, via the CLI) calls
`cairn_in_scope`:

```
cairn_in_scope({
  path_globs: ["src/auth/jwt.ts", "src/auth/refresh.ts"],
  types: ["decision"]
})
```

Cairn returns the DECs whose `scope_globs` overlap. If the task
touches only `src/billing/checkout.ts`, neither glob matches, the
function returns nothing, and the agent doesn't load `DEC-a3f7b2c` into
context. It would be noise.

### Why this matters for context efficiency

A mature project has hundreds of DECs and dozens of §INVs. Loading
all of them on every prompt would burn tokens and dilute attention.
Scope means each task gets exactly the constraints relevant to the
files it's touching:

- A change to `src/ui/button.tsx` loads UI-component decisions and
  the design-system invariants.
- A change to `src/db/schema/users.ts` loads schema-evolution
  decisions and the migration-safety invariants.
- A change to `README.md` loads documentation-style decisions and
  basically nothing else.

The SessionStart hook also uses scope: it preloads the DECs and
§INVs that apply to files you've recently touched (per git history),
so even before the agent runs any tool, the relevant context is
already in the prompt.

### Globs are real glob syntax

`scope_globs` are evaluated by `picomatch`. Standard syntax:

| Pattern                      | Matches                                              |
| ---------------------------- | ---------------------------------------------------- |
| `src/auth/**`                | Anything under `src/auth/`, recursively.             |
| `src/auth/*`                 | Direct children only.                                |
| `**/*.test.ts`               | Test files anywhere.                                 |
| `packages/{api,web}/src/**`  | Either `packages/api/` or `packages/web/` subtrees.  |

Use `**` liberally. Most decisions are about a subsystem, not a
specific file.

---

## 5. The attention queue

The attention queue is where Cairn collects everything that needs
operator review. It's not a separate UI — it's a category of state
that the `cairn-attention` skill drains interactively.

What lands in it:

| Source                       | Item kind             | Example                                           |
| ---------------------------- | --------------------- | ------------------------------------------------- |
| Adoption ingestion           | DEC drafts            | "Auth tokens expire 24h" proposed from a doc.     |
| Reviewer subagent            | DEC drafts            | "Picked `argon2id` over `bcrypt` in this PR."     |
| Source-comment ingestion     | DEC drafts + INVs     | "All API responses include x-request-id."         |
| Phase 11 baseline sweep      | Sensor findings       | "14 files reference deprecated `oldAuth.signJwt`."|
| Phase 7c rules merge         | Conflicts             | "docs/auth.md says 24h; src/auth.ts comment says 7d." |
| GC drift sweep               | Drift events          | "DEC-a3f7b2c cites `src/auth/old.ts`; file is gone." |
| Stop hook bypass detection   | Bypass alerts         | "Commit `abc1234` skipped pre-commit (--no-verify)." |

### Where it accumulates

Drafts live in `.cairn/ground/decisions/_inbox/`:

```
.cairn/ground/decisions/_inbox/
├── DEC-b1e9c04.draft.md       # awaiting triage
├── DEC-58af6d2.draft.md
└── DEC-e0c93f4.rejected.md    # rejected, kept so id stays reserved
```

Conflicts live in `.cairn/ground/conflicts/<a-id>__<b-id>.md`.
Baseline findings are in `.cairn/baseline/sensor-audit-*.yaml`. Drift
events are in `.cairn/staleness/log.jsonl`. All of these surface in
one queue when the skill reads them.

### Two ways to drain

1. **`cairn-attention` skill (in Claude Code).** Auto-invokes when the
   SessionStart hook flags `attention_count > 0`. Surfaces up to 4
   items per `AskUserQuestion` panel. For each DEC draft, options are
   `accept` / `reject` / `edit first`. For each finding, options are
   `triage now` / `suppress` / `defer`.
2. **`cairn attention` CLI.** Same operations from a terminal. Useful
   when you want to triage outside a Claude Code session.

### Auto-accept by default

Recorded decisions **auto-accept straight into the ledger** — the
human review checkpoint is the committed (or local) diff, not a
per-draft triage queue. A decision only lands in `_inbox/` as a draft
when it's a near-duplicate of an already-accepted DEC (the dedup
fallback). So the queue you triage is mostly baseline sensor findings,
drift events, and the occasional dedup-fallback draft — not hundreds
of decision drafts. Force a specific decision into the queue with
`target: "inbox"` if you want to review it before it lands.

---

## 6. Sensors

Sensors are mechanical checks that run on every diff. They don't use
an LLM; they're deterministic scripts (regex catalogs, schema parses,
glob walks). Findings flow into the attention queue.

Cairn ships four layers:

| Layer          | What it checks                                                          |
| -------------- | ----------------------------------------------------------------------- |
| **Layer A**    | Stub-pattern catalog: incomplete impls, `TODO` placeholders, fake returns. |
| **Layer B**    | Attestation cross-check: does the reviewer's claim match the actual diff? |
| **Layer C**    | Decision-assertion enforcement: was the in-scope DEC honored?           |
| **Structural** | Project-agnostic structural checks: route handlers non-empty, DTOs no fake fields. |

### When sensors run

Two gates:

1. **Pre-commit.** A versioned git hook at `.cairn/git-hooks/pre-commit`
   runs the sensor sweep against the staged diff. Fast for small
   diffs (sub-second); a few seconds for large ones. Findings
   surface inline; the commit is blocked on hard failures, surfaced
   as warnings on soft.
2. **CI gate.** `.github/workflows/cairn-check.yml` runs the same
   sensor sweep against `origin/main..HEAD`. Catches anything that
   slipped through pre-commit (e.g., commits made with
   `--no-verify`).

Both gates use the same sensor binaries. CI is the canonical
backstop.

### What a finding looks like

```yaml
- sensor: stub-pattern-catalog
  status: fail
  pattern: "throw new Error('not implemented')"
  file: src/services/payment/refund.ts
  line: 47
  severity: hard
  suggested_action: |
    Either implement the refund flow or open a TSK and cite it
    inline:  // TODO(TSK-2026-05-09-1)
```

### The decision-assertions sensor (Layer C)

This is the one that wires DECs to enforcement. A decision can carry
machine-checkable assertions:

```yaml
assertions:
  - id: a1
    kind: schema_must_contain
    table: candidate_actions
    column: actor_user_id
    column_type: uuid
  - id: a4
    kind: query_must_filter_by
    orm: drizzle
    in_globs: ["core/src/dashboard/**/*.service.ts"]
    table: candidate_actions
    columns: [organization_id, actor_user_id]
```

So the DEC isn't just rationale — it's a contract. The sensor runs
on every diff, and if a new query hits `candidate_actions` without
filtering by both `organization_id` and `actor_user_id`, the
sensor fails the commit with a citation back to the DEC.

You're not required to use assertions — many DECs are pure rationale
— but for the rules that *must* hold, assertions promote them from
"the agent should remember this" to "this commit cannot land if it
violates this."

### Why bypass detection matters

A developer can run `git commit --no-verify` and the local pre-commit
hook is skipped. That's why CI exists — the CI gate runs against the
PR, no `--no-verify` available there, and a failed sensor blocks the
merge.

But there's still a window: the developer pushed a `--no-verify`
commit, and somewhere later a CI run failed. By then the bad code is
in the repo's history. Cairn's stop-hook bypass detection closes
this: every successful pre-commit appends the resulting commit SHA
to `.cairn/.attested-commits` (gitignored, per-clone). The stop hook
diffs HEAD's last 5 commits against this file, and surfaces any
commit that wasn't attested:

> Commit `abc1234` (`"fix: quick token bump"`) was not attested by
> Cairn (likely `git commit --no-verify`).
> [a] backfill (run sensors now)
> [b] accept (record as DEC: "intentional bypass — reason?")
> [c] defer

So the workflow is: bypass is allowed but **surfaced**. You can't
silently dodge the gate.

---

## 7. Drift

Drift is the gap between what's recorded in `.cairn/` and what's
actually in the codebase or the docs.

Three concrete examples:

1. A DEC says all auth tokens use `argon2id` for hashing. Someone (or
   an agent) writes a new flow that uses `bcrypt`. The code now
   contradicts the DEC.
2. A canonical-map entry points at
   `packages/api/src/middleware/rate-limit.ts`. Someone moves the
   file to `packages/api/src/lib/rate-limit.ts`. The pointer is now
   stale.
3. A doc in `docs/api.md` references `POST /v1/refunds`. The route
   was moved to `POST /v2/refunds` six months ago and nobody updated
   the doc.

### How drift is detected

Two passes:

1. **GC sweep** (`cairn gc`, or auto-invoked by the stop hook when
   overdue). Five passes: drift, completion-integrity, scope-coverage,
   quality-grades, staleness. The drift pass cross-checks every DEC
   and §INV against the current tree:
   - Are the cited symbols still there?
   - Do the scoped files still exist?
   - Does any new code in the scope assert something the DEC
     contradicts?
2. **`PostToolUse(Write|Edit)` hook.** When an agent writes a file,
   the hook runs a deterministic scope-index sync: the new content is
   re-scanned for `§INV-<hash>` and `§DEC-<hash>` cite tokens, and the
   `scope-index.yaml` mapping (file → DECs/INVs cited) is updated
   immediately. No staleness window.

### Where drift surfaces

When the GC sweep finds drift, it writes a row to
`.cairn/staleness/log.jsonl`:

```json
{
  "ts": "2026-05-09T14:23:00Z",
  "kind": "decision_target_missing",
  "decision_id": "DEC-a3f7b2c",
  "missing_path": "src/auth/old-jwt-helpers.ts",
  "context": "DEC-a3f7b2c references this file in scope_globs but it no longer exists."
}
```

The status-line badge shows the drift count (`⬡ cairn ⚑ 3 drift`)
and the next session's SessionStart context flags it. The
`cairn-attention` skill drains it — for each drift event, options are
typically `update DEC` / `revert change` / `accept divergence (record
as new DEC)`.

### Drift is not a failure mode — it's normal

Code evolves faster than recorded rationale. The point isn't to
prevent drift, it's to surface it before it accumulates into
months-old contradictions nobody can resolve. A weekly drift sweep
that produces 3-5 events is healthy; a queue of 200 unaddressed drift
events is the warning sign.

---

## How the concepts compose

A worked example. You ask Claude Code: *"add a per-user rate limit to
the refunds endpoint."*

1. **Scope resolved.** The agent estimates target files
   (`packages/api/src/routes/refunds.ts` plus the middleware in
   `packages/api/src/middleware/rate-limit.ts`).
2. **In-scope decisions + invariants loaded.** `cairn_in_scope` returns
   `DEC-d4e6a92` (Stripe is the only payment processor — relevant
   because refunds touch Stripe), `DEC-9b0f3a7` (per-user rate limits
   use the Redis token-bucket pattern), `DEC-2e7c4d1` (refunds are
   idempotent), plus the §INVs `INV-a3f7b2c` (`x-request-id` on every
   response) and `INV-2e7c4d1` (refund operations idempotent).
4. **Canonical map consulted.** `cairn_canonical_for_topic("rate
   limiting")` returns the middleware path, so the agent reads the
   right file rather than grepping.
5. **Implementation runs.** The agent writes the code. Because the
   relevant DECs are loaded, the rate-limit uses the Redis
   token-bucket pattern (matching `DEC-9b0f3a7`) and not, say, an
   in-memory counter.
6. **Reviewer subagent fires.** Reads the diff, notices the limit was
   set to 10 requests per minute (a non-obvious choice nobody
   prompted for). Drafts `DEC-b1e9c04` proposing "Refund rate limit:
   10/min/user" and writes the attestation.
7. **Stop hook surfaces.** "Review DEC-b1e9c04 draft? `[a]` accept
   `[b]` reject `[c]` edit." You pick `[a]`. The DEC moves to the
   canonical zone.
8. **Pre-commit sensors run.** Layer A finds no stubs. Layer C
   evaluates the `INV-2e7c4d1` idempotency assertion against the diff
   — the new handler reuses the existing idempotency-key middleware,
   so the assertion passes. Layer B cross-checks the reviewer's
   attestation against the diff: claimed files match actual files,
   no claim of "tested" without a corresponding test file.
9. **Commit lands.** `.cairn/.attested-commits` gets the new SHA
   appended.

Next Friday, when you prompt *"adjust the rate limit on refunds to
20/min"*, the agent reads `DEC-b1e9c04` and updates the limit
*intentionally* — supersedes if the rationale changed, in-place
update if it's just a tuning. The choice is recorded; nothing
silently drifts.

---

## What to read next

- [`daily-flow.md`](daily-flow.md) — the concepts in motion. What you
  see in a typical session.
- [`adoption.md`](adoption.md) — what happens when you first install
  Cairn on a project.
- [`decisions.md`](decisions.md) — DEC creation, scope design, the
  supersedes chain in depth.
- [`reference.md`](reference.md) — fast lookups for CLI commands, MCP
  tools, file locations.
