# Curator pipeline — Phase 8/9/10 rewrite

**Status:** planned, not yet implemented (as of 2026-05-10)
**Target version:** 0.9.0 (minor bump — breaking change to ground-state shape)

## Problem

Adoption Phase 8 (docs-ingest), Phase 9 (source-comments), and Phase 10
(rules-merge) all share the same broken pattern:

- **Title** = `prose.split("\n")[0].slice(0, 120)` — algorithmic first-line,
  never seen by an LLM. Produces mid-sentence cuts (`"Both the counter
  bump AND the LOGIN_FAILED audit row must write to the"`), JSX-comment
  markers (`"{/* 02.2-04: Context column..."`), and bare H2 headings
  (`"Architecture"`, `"Runtime validation"`) as DEC titles.
- **Body** = verbatim raw paste of the source comment / markdown section
  / JSDoc — including `@domain`, `@orgScope`, `@see` scaffolding tags.
  No synthesis, no Context/Decision/Why template.
- **Per-block classifier** = Haiku batch sorts each block into
  `rationale | constraint | citation | license | other`. No cross-file
  awareness, no project context, no module path.
- **Auto-promotion to `status: accepted`** with no review gate.

A real ~50-package monorepo produced **129 DECs + 169 INVs** of which the
overwhelming majority are unsynthesized noise (test-file comments, JSX UI
annotations, file-format docstrings, implementation chatter). The right
magnitude is 30–80 entries total.

## Decision log

Operator-locked answers from the planning round:

| # | Question | Decision |
|---|---|---|
| 1 | Curator scope — Phase 9 only, or extend to 8 + 10? | All three. Unified curator pipeline covers source comments + docs paragraphs + rule-file H2 sections. |
| 2 | Auto-accept curator output, or land in `_inbox/` for review? | **Auto-accept.** The curator must clear a quality bar high enough that operator review is unnecessary. Validators in Stage 5 drop substandard entries silently rather than fall back to inbox. |
| 3 | Re-run behavior on `cairn init --force`? | Wipe + redo. Delete `.cairn/init/curator/` and re-dispatch. |
| 4 | Sonnet 1M / Opus / API-billed models? | **Forbidden.** Plan-quota Sonnet 4.6 (200k context) only. |
| 5 | Operator-supplied seed input pre-curator? | None. Auto-accept already commits trust; adding seed adds friction. |
| 6 | Cross-source dedup (comment+doc+rule)? | Unified corpus with `source_kind` tag. Reducer dedups across kinds. |
| 7 | Exclude `.archive/` and `.planning/archive/`? | Yes. Keep active `.planning/` (real decision sources). |
| 8 | Subagents call MCP directly, or only Stage 5 deterministic emit? | Only Stage 5. Subagents write JSONL; partial-write safety. |

## Architecture — 5-stage map-reduce

```
9a-walker    (MCP, no LLM)      ← regex pre-filter + shard
9b-curate    (skill-driven)     ← N parallel map subagents → 1 reduce subagent
9c-emit      (MCP, no LLM)      ← validate + cairn_record_decision/invariant
```

Phase 8 + Phase 10 MCP runners collapse to no-ops returning
`{ skipped: "merged-into-9-curator" }`. The 9-stage pipeline subsumes
all three source kinds.

### Stage 1 — Walker + pre-filter (MCP)

`runPhase9Walker` builds the unified corpus by running three sub-walkers:

- **Source comments** (existing `walkSourceComments` walker) → essay-class
  block comments per source file
- **Doc paragraphs** (existing `discoverDocs` + paragraph splitter) →
  README + `docs/**/*.md` paragraphs ≥80 chars
- **Rule sections** (existing `discoverRuleSources` + `parseRuleSections`) →
  H2/H3 sections from `CLAUDE.md`, `AGENTS.md`, `.claude/rules/**/*.md`

Apply regex pre-filter to drop:

```
**/*.spec.{ts,js,tsx,jsx}, **/*.test.*, **/__tests__/**
**/e2e/**, **/fixtures/**, **/snapshots/**, **/__snapshots__/**
**/migrations/**, **/dist/**, **/build/**, **/generated/**
**/vendor/**, **/node_modules/**
.tsx JSX block comments {/* … */}     (detect by surrounding `<` or `>` context)
license / SPDX headers (regex match in first ~15 lines)
JSDoc with only @param/@returns/@see/@throws, prose <30 words
TODO-only or banner-only comments
.archive/**, .planning/archive/**
mapper.off_limits_globs
```

Strip JSDoc tags (`@domain`, `@orgScope`, `@softDelete`, `@see`, etc.) from
prose before emit so they don't leak into bodies.

**Cut target: 60–80%** of raw corpus.

Output:

```
.cairn/init/curator/
├── corpus.jsonl       # one record per surviving block
└── shards.json        # module → shard index + token estimate
```

`corpus.jsonl` record schema:

```json
{
  "comment_id": "<sha7>",
  "source_kind": "comment" | "doc" | "rule",
  "file": "core/src/auth/session.ts",
  "module": "core",
  "lang": "ts",
  "prose_clean": "...",
  "enclosing_symbol": "validateSession",
  "nearby_imports": ["./db", "./crypto"],
  "module_flags": ["high_stakes", "route_handler"]
}
```

`shards.json` groups records by `module` (or by file group for docs/rules)
into shards capped at **120k input tokens** (80k headroom for system prompt
+ tool defs in Sonnet 200k context). Modules exceeding the cap split by
submodule/directory hierarchy. Never random shard.

### Stage 2 — Map subagents (skill-driven)

`cairn-adopt` skill reads `shards.json` after Stage 1 returns. Spawns one
`cairn:curator-map` subagent per shard, parallel rounds of 4 (plan-quota
rate-limit safe).

Subagent input: shard's blocks + module's mapper slice (domain summary +
project_globs + key_modules) + project domain summary.

Subagent **does not call MCP**. Writes JSONL to
`.cairn/init/curator/candidates-<shard>.jsonl`.

Per-record schema:

```json
{
  "provisional_id": "<uuid>",
  "kind": "DEC" | "INV",
  "imperative_title": "<≤80 char full sentence>",
  "context": "1-2 sentences setup",
  "decision_or_invariant": "1-2 sentences what was chosen",
  "why": "rationale + tradeoff",
  "evidence_comment_ids": ["..."],
  "evidence_files": ["core/src/auth/session.ts:42-58"],
  "proposed_scope_globs": ["core/src/auth/**"],
  "topic_tags": ["auth", "rate-limit"],
  "signature": "<domain>::<governed-behavior>::<scope>",
  "confidence": 0.0
}
```

Map subagent prompt enforces:

- Synthesize titles. **Never** `split("\n")[0]`.
- Drop UI/test/boilerplate even if regex pre-filter let them through.
- Cap **8–15 entries per shard** (forces aggressive compression).
- INV when "must hold" / modal verb + reason; DEC when "chose because".
- Intra-shard dedup.
- Empty-output is acceptable (prefer dropping over emitting borderline).

Use Sonnet `response_format` JSON schema enforcement + zod parse with one
retry on parse failure.

### Stage 3 — Reduce subagent (skill-driven)

Skill aggregates all `candidates-*.jsonl` files. Total candidate JSON ≪
raw corpus, so it fits 200k context easily.

Single `cairn:curator-reduce` subagent input: all candidates + project
domain summary + mapper key_modules.

Reducer responsibilities:

- Cluster by `topic_tags ∩ signature` similarity
- Merge cross-source duplicates (decision in code AND CLAUDE.md → 1 entry)
- Union `evidence_files` → final `scope_globs`
- Enforce final cap **30–80 entries**, target 40–60
- Final body synthesis with `## Context / ## Decision / ## Why` template

Output `.cairn/init/curator/final.jsonl`.

**Overflow safety:** if aggregated candidates exceed 150k tokens, skill
inserts a domain-tier reduce round first — algorithmic bucketing by
`topic_tags[0]`, per-bucket reducer subagent, then single repo-reducer
over survivors. Hierarchical, fully plan-quota.

### Stage 4 — Deterministic emit (MCP)

`runPhase9Emit` reads `final.jsonl`. Validates each entry strictly:

- **Title regex:** `^[A-Z][^.]*[a-z]\.?$` — capital first, ends in
  letter or period, no trailing comma/colon, no truncation
- **Body sections:** must contain literal `## Context`, `## Decision`
  (or `## Invariant` for INV), `## Why` headings
- **`scope_globs`** ≥1, each must match ≥1 file in repo
- **`evidence_files`** ≥1, each path must exist
- **No JSDoc tag leak:** body must not contain `@domain`, `@orgScope`,
  `@softDelete`, `@see`, `@param`, `@returns`
- **No title-in-body paste:** title must not appear verbatim in body
  (would indicate unsynthesized paste-through)

Invalid entries are **dropped silently** with a counter logged. No
fallback to `_inbox/` (operator's auto-accept directive — quality bar is
hard).

For surviving entries:

- `cairn_record_decision({ ..., status: "accepted", capture_source:
  "init-curator" })` for DECs
- `cairn_record_invariant({ ..., status: "active", capture_source:
  "init-curator" })` for INVs

Returns counts.

## Phase id changes

Replace `9-source-comments` with chain. Bump state schema 2 → 3.

```ts
export const PHASE_IDS = [
  "1-detect",
  "2-walker",
  "3-mapper",
  "4-seed",
  "5-preflight",
  "6-brand",
  "7-topic-index",
  "8-docs-ingest",      // → no-op (merged into curator)
  "9a-walker",          // ← new
  "9b-curate",          // ← new (skill-driven pseudo-phase)
  "9c-emit",            // ← new
  "10-rules-merge",     // → no-op (merged into curator)
  "11-baseline",
  "12-strip",
  "13-multidev",
] as const;
```

Phase 8 + 10 MCP runners return `{ skipped: "merged-into-9-curator" }`
to keep state-machine flow stable. They could be deleted entirely in a
future cleanup but staying defensive on the enum lets resumes from old
state files fail gracefully.

`parallel-8910.ts` is no longer needed — the parallel orchestration moves
into the cairn-adopt skill driving the map subagents.

## File-by-file change list

### New files

- `packages/cairn-core/src/init/phases/9a-walker.ts` — unified corpus walker
- `packages/cairn-core/src/init/phases/9c-emit.ts` — deterministic emit
- `packages/cairn-core/src/init/curator/corpus.ts` — corpus.jsonl IO + shard packer
- `packages/cairn-core/src/init/curator/regex-prefilter.ts` — drop-list regexes + JSDoc tag stripper
- `packages/cairn-core/src/init/curator/validate.ts` — strict validators (exported for smoke)
- `packages/cairn-frontend-claudecode/agents/curator-map.md` — map subagent definition
- `packages/cairn-frontend-claudecode/agents/curator-reduce.md` — reduce subagent definition
- `packages/cairn/scripts/smoke-curator-validate.ts` — feeds sample valid + invalid entries to validate.ts, asserts drop-vs-emit decisions

### Modified files

- `packages/cairn-core/src/init/phases/types.ts` — PHASE_IDS update, schemaVersion 2 → 3, new output types `WalkerOutput` / `EmitOutput`
- `packages/cairn-core/src/init/phases/state-io.ts` — `isPhaseState` accepts schemaVersion 3
- `packages/cairn-core/src/init/phases/orchestrator.ts` — `freshPhaseState` writes schemaVersion 3
- `packages/cairn-core/src/init/phases/index.ts` — export new runners
- `packages/cairn-core/src/init/phases/8-docs-ingest.ts` — collapse to no-op
- `packages/cairn-core/src/init/phases/9-source-comments.ts` — delete (replaced by 9a/9b/9c)
- `packages/cairn-core/src/init/phases/10-rules-merge.ts` — collapse to no-op
- `packages/cairn-core/src/init/phases/parallel-8910.ts` — delete (no longer used)
- `packages/cairn-core/src/init/phases/4-seed.ts` — `nextPhase` chain still flows correctly
- `packages/cairn-core/src/mcp/tools/init-phases.ts` — register new runners, drop old ones, bump zod schemaVersion to 3
- `packages/cairn-core/src/mcp/tools/init-phases.ts` — `cairn_record_decision` and `cairn_record_invariant` accept `capture_source: "init-curator"` and `evidence_files: string[]` (new field on frontmatter)
- `packages/cairn-frontend-claudecode/skills/cairn-adopt/SKILL.md` — new Step 4.5 between Phase 9a and 9c, dispatching map + reduce subagents
- `packages/cairn-frontend-claudecode/skills/cairn-adopt/SKILL.md` — phase registry table updated, ETA banner mention 9a/9c only
- `packages/cairn/scripts/smoke-init-phases-all.ts` — replace `9-source-comments` test with 9a/9c assertions
- `packages/cairn/scripts/smoke-init-phases-state.ts` — schemaVersion === 3
- `packages/cairn/scripts/smoke-init-mcp-tools.ts` — currentPhase enum updates
- `CHANGELOG.md` — 0.9.0 entry covering the rewrite
- All package.json files — version bump 0.8.x → 0.9.0

### Deleted files

- `packages/cairn-core/src/init/phases/9-source-comments.ts`
- `packages/cairn-core/src/init/phases/parallel-8910.ts`

## Subagent prompts (drafts)

### `cairn:curator-map` system prompt

```markdown
You are a Cairn ground-state curator. Your job is to extract real
load-bearing decisions and invariants from one shard of a project's
source comments / docs / rule files.

## Inputs

- shard.jsonl — array of corpus records (block comments / doc paragraphs
  / rule sections). Each has `source_kind`, `file`, `module`, `prose_clean`,
  `enclosing_symbol`, `nearby_imports`, `module_flags`.
- module slice (domain summary, key_modules entries, project_globs).
- project domain summary.

## Output

Write one JSON object per surviving entry to stdout, one per line (JSONL):

```
{
  "kind": "DEC" | "INV",
  "imperative_title": "<full sentence ≤80 chars, capitalized first letter, ends in . or letter>",
  "context": "<1-2 sentences setup>",
  "decision_or_invariant": "<what was chosen / what must hold>",
  "why": "<rationale + tradeoff>",
  "evidence_comment_ids": ["<comment_id from corpus>", ...],
  "evidence_files": ["<file:line_range>", ...],
  "proposed_scope_globs": ["<glob>", ...],
  "topic_tags": ["<short slug>", ...],
  "signature": "<domain>::<governed-behavior>::<scope>",
  "confidence": <0.0-1.0>
}
```

## Quality bar — DROP IF ANY FAIL

- Title is a fragment, mid-sentence, or contains JSX/markdown markers.
- Title appears verbatim in body (would indicate unsynthesized paste).
- Body lacks Context/Decision/Why semantic structure.
- No `evidence_files` cited.
- Comment is implementation narration ("returns the user object").
- Comment is structural label (UI layout, file format spec).
- Comment is from a test file, fixture, snapshot, generated file.
- For INV: lacks modal verb (MUST/SHALL/NEVER) or lacks "because" reason.

## Output limits

- ≤15 entries per shard. ≤8 preferred. Drop borderline cases.
- Empty output is acceptable. Better to emit nothing than emit noise.

## Style

- Imperative title: "Use X for Y" / "Reject Z when W" — never "X is used for Y".
- Body sections must read as full sentences, not bullet fragments.
- `signature` is a synthesized merge key, e.g. `auth::session-validity::edge-middleware`.
- `topic_tags` are short slugs that group related decisions across modules.
```

### `cairn:curator-reduce` system prompt

```markdown
You are the global reducer for Cairn ground-state curation. You receive
provisional candidate entries from N parallel map subagents and must
produce the final ground state.

## Inputs

- candidates.jsonl — aggregated map output from all shards.
- project domain summary.
- mapper key_modules.

## Output

Write one final entry per line to stdout (JSONL):

```
{
  "kind": "DEC" | "INV",
  "title": "<imperative ≤80 char full sentence>",
  "body": "## Context\n<1-2 sentences>\n\n## Decision\n<what was chosen>\n\n## Why\n<rationale>",
  "scope_globs": ["<glob>", ...],
  "evidence_files": ["<file:line>", ...],
  "topic_tags": ["<slug>", ...],
  "merged_from": ["<provisional_id>", ...]
}
```

For INVs use `## Invariant` instead of `## Decision`.

## Tasks

1. Cluster candidates by `topic_tags ∩ signature` similarity.
2. Merge clusters representing the same decision across files/modules
   into a single entry. Union the `evidence_files`. Pick the strongest
   title from the cluster (or rewrite if none are clean).
3. Drop low-confidence local trivia.
4. Drop entries that don't materially impact runtime behavior or public
   API stability.
5. Enforce final cap: **30–80 entries**, target 40–60. If you exceed,
   prioritize high-stakes (auth, billing, multi-tenant, payments,
   route handlers) and rule-based invariants.
6. For each survivor, rewrite body with the exact `## Context / ##
   Decision / ## Why` template (or `## Invariant` for INV).
7. Generalize `scope_globs` from clustered `evidence_files` using the
   project's known module structure (don't list every file individually
   if a module-level glob covers them).

## Quality bar

Same as map subagent, plus:
- No two entries should be paraphrases of each other.
- Each entry's `scope_globs` should be the narrowest glob that covers
  all `evidence_files`.
- Title cap 80 chars. Body cap 800 chars total.
```

## Validators (Stage 5)

Implemented in `packages/cairn-core/src/init/curator/validate.ts`:

```ts
export interface FinalEntry {
  kind: "DEC" | "INV";
  title: string;
  body: string;
  scope_globs: string[];
  evidence_files: string[];
  topic_tags: string[];
}

export interface ValidationResult {
  valid: boolean;
  rejectReason?: string;
}

export function validateEntry(
  e: FinalEntry,
  repoRoot: string,
): ValidationResult {
  // Title
  if (e.title.length === 0 || e.title.length > 80) {
    return { valid: false, rejectReason: "title-length" };
  }
  if (!/^[A-Z]/.test(e.title)) {
    return { valid: false, rejectReason: "title-no-cap" };
  }
  if (/[,:;]$/.test(e.title)) {
    return { valid: false, rejectReason: "title-trailing-punct" };
  }
  if (/\.\.\.$/.test(e.title) || /^\{\/\*/.test(e.title)) {
    return { valid: false, rejectReason: "title-truncated-or-jsx" };
  }

  // Body sections
  const requiredSections = e.kind === "INV"
    ? ["## Context", "## Invariant", "## Why"]
    : ["## Context", "## Decision", "## Why"];
  for (const sec of requiredSections) {
    if (!e.body.includes(sec)) {
      return { valid: false, rejectReason: `body-missing-${sec}` };
    }
  }

  // No JSDoc tag leak
  if (/@(domain|orgScope|softDelete|see|param|returns|throws)/.test(e.body)) {
    return { valid: false, rejectReason: "jsdoc-tag-leak" };
  }

  // No title-in-body paste
  if (e.body.includes(e.title)) {
    return { valid: false, rejectReason: "title-pasted-in-body" };
  }

  // scope_globs nonempty
  if (e.scope_globs.length === 0) {
    return { valid: false, rejectReason: "no-scope-globs" };
  }

  // evidence_files nonempty + exist
  if (e.evidence_files.length === 0) {
    return { valid: false, rejectReason: "no-evidence" };
  }
  for (const ev of e.evidence_files) {
    const path = ev.split(":")[0]; // strip line range
    if (!existsSync(join(repoRoot, path))) {
      return { valid: false, rejectReason: `evidence-missing:${path}` };
    }
  }

  return { valid: true };
}
```

## Smoke test plan

New smoke `smoke-curator-validate.ts`:

- Feed 20+ sample entries across all valid + invalid categories
- Assert `validateEntry` returns expected `valid` and `rejectReason`
- Sample categories: clean DEC, clean INV, mid-sentence title, JSX title,
  truncated body, JSDoc-tag-leaked body, missing scope_globs, missing
  evidence, paste-in-body

Existing smokes to update:

- `smoke-init-phases-all`: add Step for 9a-walker (assert corpus.jsonl
  + shards.json shape), add Step for 9c-emit (mock final.jsonl, assert
  validator drops + accepts correctly)
- `smoke-init-phases-state`: schemaVersion === 3
- `smoke-init-mcp-tools`: currentPhase enum reflects new ids

## Cost / time estimates

Per typical adoption (one-shot per repo):

- Stage 1 (walker + pre-filter): <5s, no LLM
- Stage 2 (map): 5–10 shards × ~30–60s wall-clock per Sonnet subagent,
  parallel rounds of 4 → ~1–3 minutes total
- Stage 3 (reduce): single Sonnet call, ~30–60s
- Stage 4 (validate + emit): <5s, no LLM
- **Total Phase 9 wall-clock: 2–5 minutes** (vs current ~5–20 minutes)
- **Token budget: ~500k–1.5M plan-quota Sonnet tokens per adoption**

## Open questions for implementation

1. **`evidence_files` format** — `"file.ts:42-58"` or `"file.ts#L42-L58"`?
   Pick one and enforce in validators.
2. **`signature` collision handling** — if two reducer-merged entries
   end up with identical signatures, suffix one? Or treat as further
   dedup? Probably the latter.
3. **`scope_globs` validation** — currently the validator just checks
   ≥1 entry. Should it also check the glob actually matches ≥1 file
   in the repo? Yes, but expensive; defer to a follow-up sensor.
4. **Invariant frontmatter `kind`** — the existing INV writer expects
   a particular YAML shape. Confirm the curator reducer output maps
   cleanly to that schema.
5. **MCP tool extensions** — does `cairn_record_decision` already
   accept a `body` argument that becomes the file body? If not, add it.
   Also confirm `cairn_record_invariant` exists (mirror of decision tool).
6. **Cancellation mid-Stage 2** — if the operator hits Ctrl-C during
   parallel map dispatch, candidates-*.jsonl files survive. On resume,
   should the skill replay shards whose candidates file is missing?
   Default: yes, idempotent re-dispatch.
7. **Stale-cache detection** — `--force` flag wipes `.cairn/init/curator/`.
   Without `--force`, should re-runs replay from cache or re-walk? Default:
   re-walk (deterministic), since walker is cheap.
8. **Telemetry** — record per-stage durations, candidate counts, drop
   reasons. Append to `.cairn/state/telemetry/curator.jsonl`. Useful
   for tuning the quality bar.

## Implementation order

Recommended task order for a fresh implementation session:

1. **Phase id refactor + state schema bump (skeleton, no logic).** Ship a
   PR that just renames `9-source-comments` → `9a-walker / 9b-curate /
   9c-emit` with stub runners returning `{ skipped: "WIP" }`. Update
   smokes. Verify build clean. This unblocks parallel work.
2. **Build `validate.ts` + smoke** standalone. Pure function, easy to
   test, locks the quality bar.
3. **Build 9a-walker** end-to-end. Easy to test by inspecting
   `corpus.jsonl` on a real repo.
4. **Define curator-map agent + draft prompt.** Test against a single
   real shard manually before wiring orchestration.
5. **Define curator-reduce agent + draft prompt.** Test on aggregated
   candidates from step 4.
6. **Wire skill orchestration in cairn-adopt.** Hardest part — needs
   careful Task dispatch loop, error handling, hierarchical-reduce
   trigger.
7. **Build 9c-emit** with full validators wired to MCP record tools.
8. **Phase 8 + 10 collapse to no-ops.** Last because needs everything
   else proven first.
9. **Update SKILL.md, smokes, CHANGELOG.** Ship 0.9.0.

## Acceptance criteria

A successful curator pipeline run on a typical adopted project produces:

- 30–80 ground-state entries total (DECs + INVs combined)
- Every title is a full imperative sentence ≤80 chars
- Every body has the exact `## Context / ## Decision / ## Why` (or `##
  Invariant`) template
- Zero `@domain`, `@orgScope`, `@see` tag leaks in any body
- Zero entries from `*.spec.ts`, `*.test.ts`, `e2e/fixtures/**`,
  `.tsx` JSX-only comments, `.archive/**`
- Every entry has ≥1 `evidence_files` path that exists in the repo
- Operator running `cairn attention` post-adoption sees an empty queue
  (curator output auto-accepts, no `_inbox/` drafts)

If any of these fail in production, the curator pipeline regressed and
should be patched before the next release.

---

## References

- Original problem report: gcb-platform adoption produced 129 DECs +
  169 INVs of mostly garbage (mid-sentence titles, raw JSDoc paste,
  test-file comments promoted, etc.)
- Original conversation: see commit `1e8cb4a` for the 0.8.3 cleanup
  that preceded this plan (pilot-prompt rip, ETA pre-flight, hook fixes)
- Multi-model architecture review: 4 frontier models (ChatGPT 5.5,
  ChatGPT o3, Gemini, Claude) all converged on map → cluster →
  synthesize → emit map-reduce architecture under plan-quota
  Sonnet 200k constraint
