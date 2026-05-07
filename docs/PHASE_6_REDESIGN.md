# Phase 6 (docs ingestion) redesign — locked spec

Status: **APPROVED design**, not yet implemented.

This document is the authoritative spec for the phase-6 redesign. It supersedes the conversational artifacts in `gemini-phase6-evaluation.md`, `gemini-phase6-evaluation-r2.md`, and `gemini-phase6-evaluation-r3.md` (kept at repo root for the audit trail of how this design was reached).

---

## 1. Problem

The original phase-6 implementation Haiku-classifies every paragraph in every markdown file under the adopted repo, producing one DEC per paragraph. On a real adopted project (gcb-platform):

- **7548 candidate paragraphs** across 307 distinct `.md` files (~24.6 paragraphs/file average).
- **~12 s wall per Haiku subprocess call** (cold-start + inference + JSON-schema validation).
- **Sequential `for ... of` loop** in `sot-emit.ts` awaited one classifier per entry.
- **Total: ~25 hours wall, ~7000 noisy DECs in the ledger**, large fraction of operator's coding-plan Haiku quota burned on UAT logs / status reports / plan docs.

A subsequent batch-classifier optimization (N=30 sections per call, concurrency 5) cut that to ~15 minutes — but produced the **same noisy ledger**. The performance problem was downstream of an architectural mistake.

## 2. Reframe

A "decision" is not a linguistic property of a paragraph. It cannot be reliably deduced from grammar, keywords, or isolated semantics. **A decision is a social consensus or an active operational constraint.** UAT checklists and `.planning/` scratchpads contain declarative sentences that look identical to decisions to an LLM but lack the social weight of a canonical rule.

Asking Haiku to judge 7548 isolated paragraphs is structurally wrong. The right question:

> **How do we bootstrap a high-signal ledger using only structural context and explicit markers, treating `cairn init` as a "seed" rather than a "complete data migration"?**

If `init` produces 30-80 canonical DEC drafts and leaves ~7000 items as queryable topic-index candidates, *that is a success* — provided there is a frictionless path to promote candidates later as the operator and AI agents work.

## 3. Locked design constraints

Per `CLAUDE.md` operator profile, non-negotiable:

| Constraint | Implication |
|---|---|
| No env vars | All thresholds, model IDs, defaults hardcoded in code |
| No hardcoded paths except `.claude/` | Walker cannot special-case `docs/`, `.planning/`, `ops/`, `archive/`, etc. `.claude/` is the only allowed hardcoded path because it's Claude Code's own config dir |
| No backward-compat shims, hard cutovers only | Schema changes are clean breaks. Migration path = `rm -rf .cairn/ && cairn init` |
| Tests = sensors + E2E smokes only | No unit-test framing |
| `PreToolUse` hooks banned | SessionStart instructions + MCP tools only |

## 4. Locked architecture

### 4.1 Phase 6 — staged docs ingest

Replaces the current bulk-classifier path entirely.

```
Stage 1 — file-purpose Haiku BINARY filter
  Input per file (assembled by phase 5b walker, no extra IO):
    - filename + relative path
    - frontmatter YAML (if present)
    - first 800 chars of body (frontmatter stripped)
    - Table of Contents: every H1/H2/H3 line, capped at first 100 lines of headings
  Batch: 30 files / Haiku call. Concurrency: 5.
  System prompt (LOCKED, do not paraphrase):
    "You are a rigid filter for an architecture ledger. A file is
     authoritative ONLY if it is a canonical rulebook, a formal
     Architecture Decision Record (ADR), or a list of active,
     binding domain invariants. If a file is a project plan,
     research scratchpad, UAT log, status update, or API
     documentation, it is NOT authoritative, even if it contains
     proposed or historical decisions.
     Evaluate filepath, frontmatter, intro, ToC. Return JSON:
     { is_authoritative: boolean, reason: '10 words max' }"
  Output: tri-state collapsed to BINARY — { is_authoritative, reason }
  Wall on gcb-platform: 307 files / 30 / 5 × ~18s ≈ 37s

Stage 2 — section-level Haiku batch, scoped
  Source: every section from is_authoritative=true files, MINUS sections
          already handled by Stage 3 marker override.
  Batch: 30 sections / call, concurrency 5.
  Same classifier shape as the existing classifyBatch.
  Wall on gcb-platform: ~300 sections / 30 / 5 × ~18s ≈ 36s

Stage 3 — marker override (deterministic, 0 Haiku)
  Always-emit when ANY of these match:
    - parent file frontmatter has `cairn: { kind: decision | rule }`
    - section heading is followed (within 3 lines) by `<!-- cairn:decision -->`
      or `<!-- cairn:rule -->`
  Marker detection happens in the walker. Each ProseBlock is stamped with
  `marker_kind: "decision" | "rule" | undefined` so phase 6 reads it off
  the topic-index entry without re-walking the file.
  Bypasses Stages 1-2.

Stage 4 — emit
  Stage 2 + Stage 3 outputs → DEC drafts in `.cairn/ground/decisions/_inbox/`
  Frontmatter:
    status: draft
    capture_source: init-docs-ingest  (Stage 2 + 3)  OR  ai-proposed (cairn_propose_decision)
    decided_by: cairn-init  OR  ai-curator
  Body: VERBATIM via readSotBody — no AI paraphrasing allowed.
  Operator triages via existing cairn-attention skill.

Final phase 6 wall: ~75s. Haiku calls: ~21. Drafts: ~30-80.
Topic-index candidates remaining: ~7000 (queryable, not noise).
```

### 4.2 Phase 5b additions

Existing: build topic-index + anchor-map.

New outputs:

```
.cairn/ground/file-candidates-map.yaml
  file_candidates:
    "docs/13-OPEN-DECISIONS.md": 15
    ".planning/02.4-RESEARCH.md": 113
    "ops/uat/2026-04-26-uat-biller.md": 18
    ...
```

O(1) per-file lookup for the read-enrich hook (avoids O(reads × candidates) blowup).

End of phase 5b also runs `_rejected.yaml` GC: load `.cairn/ground/_rejected.yaml`, filter out entries whose slug is no longer present in the freshly-built topic-index, save. Keeps index-maintenance centralized in the index-builder.

### 4.3 Phase 7b — source-comments redesign

Walker still finds essay-class block comments (>3 lines / >200 chars / JSDoc with >30 prose words).

**Per-essay regex pre-filter:**

```
/(MUST|MUST NOT|SHALL|NEVER|ALWAYS|REQUIRED|FORBIDDEN|INVARIANT|@invariant|@rule|@decision|@cairn:decision|@cairn:rule)/i
```

Essays matching → batch classifier (existing N=30 / concurrency 5 path).
Essays not matching → topic-index candidate only, no DEC emit.

Marker override (`@cairn:decision` / `@cairn:rule`) always emits regardless.

Code uses rigid documentation conventions, so regex is safe here (unlike arbitrary prose). False negatives — passive-voice invariants like "Token expiry is enforced via..." — are accepted loss; the file's candidates remain in topic-index, AI can promote later.

### 4.4 Phase 7c — rules-merge — UNCHANGED

Naturally narrow scope (`.claude/rules/*` + `CLAUDE.md` + `AGENTS.md`). Already small (~50-100 sections on a busy repo). Keep as-is.

### 4.5 Phase 8 — baseline sensor — UNCHANGED

Phase 8 stays focused on DEC vs SOT drift. `_rejected.yaml` GC moved to phase 5b (see 4.2).

### 4.6 New MCP tools

#### `cairn_search_candidates({ query?, scope?, kind?, limit? })`

Queries topic-index entries WHERE `dec_id IS NULL`.
- `query` — fuzzy match on body / title (optional).
- `scope` — path glob filter (optional, e.g. `"docs/**"`).
- `kind` — ProseBlockKind filter (optional).
- `limit` — default 50.

Returns `[{ slug, title, sot_source, line_range, body_preview }]`. Mirrors the shape of `cairn_decisions_in_scope` so AI agents can use it interchangeably.

#### `cairn_propose_decision({ slug, title?, kind? })`

Promotes a topic-index candidate to a DEC draft.

```
Behavior:
  1. Resolve slug → topic-index entry. If not found: { ok: false, reason: "not_found" }.
  2. If entry.dec_id is set: idempotent — return existing { ok: true, dec_id, path, warning: "already exists" }.
  3. If slug appears in _rejected.yaml: { ok: false, reason: "rejected", detail: <reason> }.
  4. Drift check: read body via readSotBody; recompute body hash; compare to entry.content_hash.
     If mismatch: { ok: false, reason: "drifted", detail: "Source modified since index build. Run 'cairn index' to refresh." }.
  5. Otherwise: emit DEC draft to _inbox/, stamp dec_id on topic-index entry, return:

     { ok: true,
       dec_id,
       path: ".cairn/ground/decisions/_inbox/<dec_id>.draft.md",
       warning: "Created draft from slug <slug>. Status=draft, pending operator review via cairn-attention.
                 DO NOT enforce this rule yet — proposal only. You MAY cite as 'proposed (<dec_id>, draft)'." }
```

`title` is the only field the AI may supply; `body` is ALWAYS verbatim from `readSotBody` to preserve `sot_content_hash` integrity (the drift sensor depends on it).

`capture_source: "ai-proposed"`, `decided_by: "ai-curator"` in the frontmatter.

#### `cairn_reject_candidate({ slug, reason })`

Appends to `.cairn/ground/_rejected.yaml`. Dedupe by slug — first-writer wins the `reason` string, subsequent writes update `rejected_at` only.

```yaml
rejected:
  - slug: "abc123def456"
    rejected_at: "2026-05-07T10:30:00Z"
    rejected_by: "operator" | "ai-curator"
    reason: "false-positive — research note, not a decision"
    sot_source: ".planning/02.4-RESEARCH.md"
    line_range: [142, 178]
```

Drift sensor reads this file, suppresses any candidate whose slug appears here. Phase 6 / `cairn ingest` skip rejected slugs.

### 4.7 Read-enrich hook extension

Existing PostToolUse hook on `Read` already injects DEC summaries for files referenced in scope-index. Addition:

```ts
const candidates = fileCandidatesMap.get(filepath) ?? 0;  // O(1) lookup
if (candidates >= 1) {
  prepend(`⚠ This file has ${candidates} unpromoted topic-index candidates.
           If a passage states an active rule the operator has committed to,
           call cairn_propose_decision({ slug }) to surface it for operator review.
           Do NOT propose for narrative, plans, or status content.`);
}
```

Turns AI agents into active curators during normal work.

### 4.8 New CLI: `cairn tag`

```
cairn tag --insert-marker <pattern> <file-or-dir> [--force] [--force-pattern]
```

Operator-driven retro-tagging of existing decision docs. Inserts `<!-- cairn:decision -->` after each line matching `<pattern>`.

**Safety model:**

1. Git-aware. Pre-flight runs `git status --porcelain <file>` for each target. If any target is dirty AND `--force` not passed: abort with the dirty file list.
2. Impact circuit breaker. Run pattern over targets in memory first. For each file, if matches > 30 % of total lines: abort that file with `WARN: <pattern> matched >30% of lines in <file>. Skipping. Use --force-pattern to override.`
3. Idempotent. Look ahead **3 lines** (not just 1) for an existing `<!-- cairn:decision -->` marker before inserting — handles blank lines between heading and decision body.

Deterministic, 0 Haiku.

### 4.9 Cold-start UX

`cairn init` final stdout (LOCKED wording):

```
Adopted <project> in <duration>.
- <N> active rules baseline verified.
- <M> new decision drafts found.
- <K> unpromoted candidates indexed.

Run `cairn attention` to review drafts and commit them to the ledger.
```

No auto-wizard. No statusline drumbeat. Operator drives the next step.

## 5. Implementation skeleton

### 5.1 Walker marker stamping

`packages/cairn-core/src/init/topic-index/walk.ts`:

```ts
interface ProseBlock {
  // existing fields …
  marker_kind?: "decision" | "rule";   // NEW — set when frontmatter or HTML-comment marker found
}

// In extractSections / extractParagraphs:
//   - read frontmatter, check `cairn.kind` field → file-level marker for all blocks in file
//   - within section body, scan first 3 lines after heading for
//     `<!-- cairn:decision -->` / `<!-- cairn:rule -->` → block-level marker
//   - stamp ProseBlock.marker_kind accordingly
```

Walker stamping centralizes marker detection at parse time. Phase 6 reads `entry.marker_kind` directly off the topic-index entry — no re-walking.

### 5.2 Phase 6 orchestration

`packages/cairn-core/src/init/ingest-docs.ts`:

```ts
export async function runDocsIngestion(args: RunDocsIngestionArgs): Promise<IngestionResult> {
  const topicIndex = readTopicIndex(args.repoRoot);
  const anchorMap = readAnchorMap(args.repoRoot);
  const rejected = readRejectedYaml(args.repoRoot);   // NEW

  const allEntries = Object.values(topicIndex.topics).filter(e =>
    isDocSoT(e) && e.dec_id === undefined && !rejected.has(e.slug)
  );

  // Stage 3 — marker scan (deterministic, 0 Haiku)
  const markerEmits = allEntries.filter(e => e.marker_kind !== undefined);

  // Stage 1 — file-purpose binary filter
  const distinctFiles = [...new Set(allEntries.map(e => e.sot_source))];
  const authoritativeFiles = await fileFilterPhase(distinctFiles, args.repoRoot);

  // Stage 2 — section batch classifier (existing)
  const stage2Candidates = allEntries.filter(e =>
    authoritativeFiles.has(e.sot_source) && e.marker_kind === undefined
  );
  const sectionVerdicts = await batchClassifySections(stage2Candidates, args);

  // Stage 4 — emit
  const finalEmits = [
    ...markerEmits.map(e => ({ entry: e, kind: e.marker_kind!, title: deriveMarkerTitle(e) })),
    ...sectionVerdicts.filter(v => v.kind === "decision" || v.kind === "domain-rule"),
  ];
  await emitDecisionsToInbox(finalEmits, args.repoRoot);

  return { drafts: finalEmits.length, candidates: allEntries.length - finalEmits.length };
}
```

### 5.3 Stage-1 file-purpose filter

```ts
interface FileFilterInput {
  path: string;
  frontmatter: string | null;
  introChars: string;       // first 800 chars, post-frontmatter
  toc: string;              // every H1/H2/H3 line, max 100 lines
}

const FILE_FILTER_SCHEMA = {
  type: "object",
  required: ["files"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "is_authoritative", "reason"],
        properties: {
          path: { type: "string" },
          is_authoritative: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const FILE_FILTER_SYSTEM = `You are a rigid filter for an architecture ledger. A file is authoritative ONLY if it is a canonical rulebook, a formal Architecture Decision Record (ADR), or a list of active, binding domain invariants.

If a file is a project plan, research scratchpad, UAT log, status update, or API documentation, it is NOT authoritative, even if it contains proposed or historical decisions.

Evaluate the provided filepath, frontmatter, intro, and Table of Contents. Return JSON: { is_authoritative: boolean, reason: "10 words max" }`;
```

### 5.4 `cairn_propose_decision` MCP tool

```ts
// packages/cairn-core/src/mcp/tools/propose-decision.ts (new)

export async function cairn_propose_decision(args: {
  slug: string;
  title?: string;
  kind?: "decision" | "rule";
}): Promise<ProposeDecisionResult> {
  const topicIndex = readTopicIndex(repoRoot);
  const entry = topicIndex.topics[args.slug];
  if (entry === undefined) return { ok: false, reason: "not_found", detail: "slug not in topic-index" };

  if (entry.dec_id !== undefined) {
    return {
      ok: true,
      dec_id: entry.dec_id,
      path: pathFor(entry.dec_id),
      warning: "DEC draft already exists for this slug; returning existing.",
    };
  }

  const rejected = readRejectedYaml(repoRoot);
  if (rejected.has(args.slug)) {
    return { ok: false, reason: "rejected", detail: rejected.get(args.slug)!.reason };
  }

  const body = readSotBody(repoRoot, entry, anchorMap);
  if (body === null) return { ok: false, reason: "unreadable", detail: "anchor-map missing or body unreadable" };

  // DRIFT CHECK
  const currentHash = bodyContentHash(body);
  if (currentHash !== entry.content_hash) {
    return {
      ok: false,
      reason: "drifted",
      detail: "Source file modified since index build. Run 'cairn index' to refresh.",
    };
  }

  const decId = deriveDecId({ sot_path: entryToSotPath(entry), title: args.title ?? firstLineFallback(body), capture_source: "ai-proposed" });
  writeDraftToInbox({ id: decId, title: args.title ?? firstLineFallback(body), body, kind: args.kind ?? "decision", entry, capture_source: "ai-proposed", decided_by: "ai-curator" });
  stampTopicIndex(args.slug, decId);

  return {
    ok: true,
    dec_id: decId,
    path: `.cairn/ground/decisions/_inbox/${decId}.draft.md`,
    warning: `Created draft from slug ${args.slug}. Status=draft, pending operator review via cairn-attention. DO NOT enforce this rule yet — proposal only. You MAY cite as "proposed (${decId}, draft)".`,
  };
}
```

### 5.5 `cairn tag` CLI

```ts
// packages/cairn/src/cli/tag.ts (new)

const IMPACT_RATIO_LIMIT = 0.30;
const MARKER_LOOKAHEAD_LINES = 3;
const MARKER_TEXT = "<!-- cairn:decision -->";

export async function cmdTag(args: {
  insertMarker: string;
  target: string;
  force: boolean;
  forcePattern: boolean;
}): Promise<number> {
  const targets = await resolveTargets(args.target);
  const dirty = await Promise.all(targets.map(checkGitStatus));
  const dirtyFiles = dirty.filter(d => d.dirty).map(d => d.path);
  if (dirtyFiles.length > 0 && !args.force) {
    process.stderr.write(`Error: ${dirtyFiles.length} files have uncommitted changes:\n`);
    for (const p of dirtyFiles.slice(0, 5)) process.stderr.write(`  - ${p}\n`);
    process.stderr.write(`Commit/stash first or pass --force.\n`);
    return 1;
  }

  const pattern = new RegExp(args.insertMarker, "m");
  let totalInserted = 0;
  for (const file of targets) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    const matchCount = lines.filter(l => pattern.test(l)).length;
    const ratio = matchCount / Math.max(1, lines.length);
    if (ratio > IMPACT_RATIO_LIMIT && !args.forcePattern) {
      process.stderr.write(`WARN: pattern matched ${(ratio * 100).toFixed(0)}% of lines in ${file}. Skipping. Use --force-pattern to override.\n`);
      continue;
    }
    const out: string[] = [];
    let insertedHere = 0;
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i]!);
      if (pattern.test(lines[i]!)) {
        // Lookahead: scan next 3 lines for an existing marker.
        const window = lines.slice(i + 1, i + 1 + MARKER_LOOKAHEAD_LINES).join("\n");
        if (!window.includes(MARKER_TEXT)) {
          out.push(MARKER_TEXT);
          insertedHere += 1;
        }
      }
    }
    if (insertedHere > 0) {
      writeFileSync(file, out.join("\n"));
      totalInserted += insertedHere;
    }
  }
  process.stdout.write(`Inserted ${totalInserted} markers across ${targets.length} files.\n`);
  return 0;
}
```

### 5.6 `_rejected.yaml` schema

```yaml
# .cairn/ground/_rejected.yaml
rejected:
  - slug: "abc123def456"
    rejected_at: "2026-05-07T10:30:00Z"
    rejected_by: "operator"
    reason: "false-positive — research note, not a decision"
    sot_source: ".planning/02.4-RESEARCH.md"
    line_range: [142, 178]
```

Reader / writer (`packages/cairn-core/src/ground/rejected.ts`):

- `readRejectedYaml(repoRoot): Map<slug, RejectedEntry>` — slug-keyed for O(1).
- `appendRejected(repoRoot, entry)` — dedupe by slug. First-writer wins `reason`; second-writer updates `rejected_at` only.

### 5.7 Phase 5b GC

End of `buildTopicIndex`:

```ts
const rejected = readRejectedYaml(repoRoot);
const liveSlugs = new Set(Object.keys(result.topicIndex.topics));
const cleaned = new Map<string, RejectedEntry>();
for (const [slug, entry] of rejected.entries()) {
  if (liveSlugs.has(slug)) cleaned.set(slug, entry);
}
writeRejectedYaml(repoRoot, cleaned);
```

## 6. Smoke surface

Existing smokes that need updates:

- `smoke:topic-index` — assert `file-candidates-map.yaml` written, content correct, `_rejected.yaml` GC drops dead slugs.
- `smoke:init` — assert phase 6 emits drafts to `_inbox/` (not `decisions/`); cold-start stdout matches §4.9 spec.
- `smoke:e2e-adoption` — full pipeline.
- `smoke:source-comments` — assert phase 7b regex pre-filter rejects narrative essays, accepts imperative-keyword essays.
- `smoke:read-enrich` — assert candidate-injection fires when file has candidates, suppressed when not.

New smokes (mocked LLM unless noted):

- `smoke:propose-decision` — idempotent slug behavior, rejected slug refusal, drift detection refusal, draft emission shape.
- `smoke:reject-candidate` — `_rejected.yaml` append, dedupe by slug.
- `smoke:search-candidates` — query / scope / kind filter shapes, dec_id filter.
- `smoke:tag-cli` — git-status guard, `--force` escape, `--force-pattern` escape, idempotent insertion with blank-line lookahead.
- `smoke:llm-prompt-eval` — **uses real Haiku.** 3 hardcoded fixtures (1 real ADR, 1 UAT log, 1 research doc). Asserts exact `is_authoritative` booleans. Operator runs only when touching prompts or upgrading models. Documented as opt-in, not part of standard smoke gate.

Total smoke surface after this redesign: 22 existing + 5 new = **27 entries**, plus the opt-in `smoke:llm-prompt-eval`.

## 7. PR-split plan

Each PR ships independently. Dependencies are linear.

### PR 1 — Phase 6 redesign + file-candidates-map
- Stage 1 file-purpose filter (binary, ToC input, locked prompt).
- Phase 6 orchestration replacing bulk classifier.
- Phase 5b extension: `writeFileCandidatesMap` + `_rejected.yaml` GC.
- Walker stamps `marker_kind` on `ProseBlock`.
- Cold-start CLI output rewrite (terse 4-line summary per §4.9).
- Smoke updates: `init`, `topic-index`, `e2e-adoption`.

### PR 2 — New MCP tools + read-enrich hook
- `cairn_search_candidates`.
- `cairn_propose_decision` (with locked "do not enforce" wording + drift check).
- `cairn_reject_candidate`.
- `_rejected.yaml` schema + reader/writer.
- Read-enrich hook extension (O(1) lookup via `file-candidates-map.yaml`).
- Smoke additions: `propose-decision`, `reject-candidate`, `search-candidates`.
- Smoke updates: `read-enrich`.

### PR 3 — `cairn tag` CLI + phase 7b regex pre-filter
- `cairn tag --insert-marker` subcommand with git-status guard, impact circuit breaker, 3-line lookahead.
- Phase 7b regex pre-filter.
- Smoke additions: `tag-cli`.
- Smoke updates: `source-comments`.

### PR 4 — Opt-in real-LLM smoke
- `smoke:llm-prompt-eval` against 3 fixtures.
- Documentation (this file) marked as opt-in.

Each PR has a clear win:
- PR 1: phase 6 wall drops 25 h → ~75 s. Headline.
- PR 2: AI curator path lights up. Topic-index candidates become reachable.
- PR 3: operator-driven migration tooling. Phase 7b stops bulk-noising.
- PR 4: prompt regression detection.

## 8. Migration path (existing adopted projects)

Hard cutover. Honors §3 no-shims constraint.

```bash
rm -rf .cairn/
cairn init
```

Operators with hand-edited DECs they want to preserve must back them up before wipe.

No `--rebuild` flag. No transition layer. Schema evolution via clean break.

## 9. Out-of-scope / follow-up

Logged for separate work, not part of PRs 1-4:

- **Inbox triage fatigue**: 30-80 drafts × sequential `cairn-attention` prompts is poor UX on cold start. Future: `cairn attention --accept-all` batch path.
- **Scope-index ↔ topic-index disconnect**: phase-3 mapper currently maps source files → DEC IDs. AI agents discover candidates only if they `Read` the markdown. Future: phase-3 also maps source files → topic-index slugs so `cairn_decisions_in_scope` can surface candidate suggestions when an agent works on `core/billing.ts`.
- **Embedding-based candidate ranking**: when many candidates exist in a file, the read-enrich hook just states the count. A future pass could rank candidates by relevance to recent agent activity.

## 10. Audit trail

Three rounds of architectural review with Gemini. Conversational artifacts kept at repo root for posterity:

- `gemini-phase6-evaluation.md` — Round 1 prompt + response. Established the reframe ("seed not migration").
- `gemini-phase6-evaluation-r2.md` — Round 2 prompt + response. Surgical adjustments: collapse tri-state to binary, ToC over math ratios, file-candidates-map for O(1) hook lookup, regex pre-filter for phase 7b.
- `gemini-phase6-evaluation-r3.md` — Round 3 prompt + response. Final polish: `cairn tag` blank-line idempotency, drift detection in `propose_decision`, `_rejected.yaml` GC moved to phase 5b, dedupe by slug, `cairn tag` impact circuit breaker.

Round 3 closed with explicit "no Round 4 necessary, ready to write code."

This spec is the locked synthesis. Code follows.
