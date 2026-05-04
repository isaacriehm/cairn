# Harness Build Master Prompt

**Paste this entire file into your Claude Code Opus session and walk away. It is fully autonomous.**

---

## ORIENTATION

You are completing the Harness codebase — a TypeScript pnpm monorepo that acts as a "project brain" for Claude Code. It maintains ground state (decisions, invariants, brand, product context), hooks into Claude Code's session lifecycle to inject that state, and runs deterministic sensors on diffs before they land.

The codebase already exists and **compiles clean today**. Your job is 14 surgical additions and modifications against the updated spec. You are not building from scratch.

Repo root: the directory containing this file (one level up from `harness-build/`).

---

## GROUND RULES — read before touching any code

**1. Subagents for every implementation task.**
Every numbered task below MUST be executed via a `Task` subagent, not directly by you. You are the orchestrator. You read, plan, review, verify, and commit. Subagents write code.

**2. Subagent briefs must be self-contained.**
A subagent starts with zero context. Your Task prompt must include:
- 2-sentence description of Harness
- The **full text** of every spec section relevant to the task (read the spec files, paste the content — do not reference by path)
- The **full text** of every existing source file being modified or extended
- The TYPESCRIPT CONSTRAINTS block below
- The exact task, file list, and acceptance criteria

Never write a subagent prompt that says "read `docs/X.md` for context." The subagent cannot be trusted to read the right sections. You paste the content yourself.

**3. Compile gate before every commit.**
After each task's subagent completes:
```bash
cd packages/harness-core && npx tsc --noEmit 2>&1
cd harness && npx tsc --noEmit 2>&1
```
Both must pass with zero errors before you commit. If either fails, build a remediation brief from the exact error output and re-dispatch the subagent (max 2 retries). If it still fails after 2 retries, commit what compiles, mark the task `PARTIAL` in your build log, and continue.

**4. Git discipline — commit after every passing task.**
```bash
git add -A
git commit -m "feat(harness): <task-name>"
```
Every commit is a recovery point. If your context degrades mid-build, the git history is the complete state.

**5. Write the build log after every task.**
Append to `harness-build/BUILD_LOG.md` after each task:
```
## Task N — <name> [DONE|PARTIAL|FAILED] <timestamp>
Subagent attempts: N
Compile: PASS|FAIL
Notes: <anything unusual>
```

**6. Context management.**
When your context bar hits 60%, complete the current task, commit, append to the build log, then write `harness-build/RESUME.md` with: last completed task number, git HEAD SHA, and any task-specific context the next instance needs. Then continue. If you hit 80%, write RESUME.md immediately and keep working — you have more runway than you think.

**7. Quality bar for subagent output.**
Reject and re-dispatch if:
- Any `any` type in new/modified TypeScript
- Any unimplemented throw, empty function body, or `// TODO` in delivered code
- Import of a module that doesn't exist yet (broken import)
- TypeScript compile failure

---

## TYPESCRIPT CONSTRAINTS — paste into every subagent brief

Both packages compile under `tsconfig.base.json` with these strict knobs enabled. Idiomatic TS that ignores them WILL fail the compile gate.

**1. `exactOptionalPropertyTypes: true`** — `field?: T` does NOT include `undefined`. Assigning `undefined` to an optional field is a type error. The codebase pattern for conditionally-set optional fields:
```ts
const obj: { x?: string } = {
  ...(maybeX !== undefined ? { x: maybeX } : {}),
};
```
NOT `{ x: maybeX }` when `maybeX` could be `undefined`. Existing files in `packages/harness-core/src/ground/ledgers.ts`, `init/init.ts`, etc. demonstrate the idiom heavily.

**2. `noUncheckedIndexedAccess: true`** — `arr[i]` and `record[key]` return `T | undefined`. Subagents must guard:
```ts
const first = arr[0];
if (first === undefined) continue;
first.foo;  // ok
```
`arr[0].foo` will not compile.

**3. `strict: true`** — implicit `any` is forbidden. New/modified code must declare every parameter type. Return types inferred when trivially obvious; explicit otherwise.

**4. Module resolution: `NodeNext`** — every relative import MUST end in `.js`, even when importing from a `.ts` source file (`./foo.js`, never `./foo` and never `./foo.ts`). All existing imports use this convention.

**5. No `any` in delivered code.** If a value is genuinely `unknown`, narrow it with a type guard or zod schema before use; do not cast through `any` or `as`.

**6. No `import("…").X` type-references.** Top-level `import type { X } from "./foo.js"` only. Inline `import()` type expressions are banned project-wide.

If a subagent's output trips any of these, the compile gate will reject it and we burn an Opus retry. Make sure every brief includes this block verbatim.

---

## ORDERED TASK LIST

Work through these in order. Each has a `READ FIRST` block — read those files before writing the subagent prompt.

---

### TASK 1 — Remove banned MCP tools from public surface + clean up SessionStart tool reference

**READ FIRST:**
- `packages/harness-core/src/mcp/tools/index.ts` (full file)
- `packages/harness-core/src/session-start/templates.ts` (full file)
- `docs/MCP_SURFACE.md` (§ "What is NOT in this surface")

**Context to paste into subagent:**
The updated MCP spec removes 4 tools from the public agent-facing surface. The source files can stay (used internally by harness-runtime) but they must be removed from `allTools` in the index AND from the SessionStart `TOOL_QUICK_REFERENCE` template, since SessionStart advertises tools to fresh agents and currently lists tools that will fail with `tool not found`.

**Files to modify:**
- `packages/harness-core/src/mcp/tools/index.ts`
- `packages/harness-core/src/session-start/templates.ts`

**Step 1 — `mcp/tools/index.ts`** — remove from `allTools` array AND their imports:
- `appendTool` (`./append.js`)
- `askOperatorTool` (`./ask-operator.js`)
- `recordRunEventTool` (`./record-run-event.js`)
- `dropTaskTool` (`./drop-task.js`)

Keep all source files in `mcp/tools/` — only remove the array entries and the import lines.

**Step 2 — `session-start/templates.ts`** — in the `TOOL_QUICK_REFERENCE` constant, delete these three lines from the "Write" section:
```
  harness_record_run_event(run_id, event)   — append to events.jsonl
  harness_drop_task(...)                    — file a new active task
```
And delete the entire "Operator dialog" sub-block:
```
Operator dialog:
  harness_ask_operator(run_id, question, options[]?, category?, timeout_ms?)
                                            — pause + ask, polls for answer
```
Leave a single trailing newline at end. Do not add `harness_append_run_note` here yet — that comes in Task 12.

**Acceptance criteria:**
- `allTools` array has **14 entries** (will become 15 after Task 12 lands).
- `TOOL_QUICK_REFERENCE` contains no mention of `harness_record_run_event`, `harness_drop_task`, or `harness_ask_operator`.
- `cd packages/harness-core && npx tsc --noEmit` passes.

---

### TASK 2 — Status line module

**READ FIRST:**
- `docs/STATUS_LINE_SPEC.md` (full file)
- `packages/harness-core/src/ground/paths.ts` (understand path conventions)
- `packages/harness-core/src/index.ts` (the public barrel)
- `harness/src/cli/index.ts` (full file — the usage block needs an entry)

**Context to paste:** Full content of all four files.

**Files to create:**
- `packages/harness-core/src/status-line/writer.ts` — `writeStatusJson(repoRoot: string, patch: Partial<StatusJson>): void` reads any existing `~/.local/harness/state/<slug>/status.json`, merges `patch` over it, and writes back. The `<slug>` is derived from the basename of `repoRoot`. mkdirs as needed.
- `packages/harness-core/src/status-line/format.ts` — pure function `formatStatus(s: StatusJson): string` returns the display string per STATUS_LINE_SPEC §1: `⬡ harness  ctx:N/M  decisions:N  inv:N  task:idle  ●` etc.
- `packages/harness-core/src/status-line/reader.ts` — `readStatusForCLI(repoRoot: string): string` reads the state file (or returns a placeholder string `⬡ harness  daemon:down  ○` if missing/unreadable) and pipes it through `formatStatus`.
- `packages/harness-core/src/status-line/index.ts` — barrel re-export of `writeStatusJson`, `readStatusForCLI`, `formatStatus`, and the `StatusJson` type.

**Files to modify:**
- `packages/harness-core/src/index.ts` — add `export * from "./status-line/index.js";` near the other subdir re-exports.
- `harness/src/cli/index.ts` — add a `case "status-line":` branch that resolves an optional `--project-root <path>` flag (defaults to `process.cwd()`), calls `readStatusForCLI(resolvedRoot)`, and prints the result to stdout. Add a one-line entry in the `usage()` help text:  `  status-line  print formatted status line for the daemon-maintained state file (--project-root <path>?)`.

**Status JSON shape** (must export this type from `status-line/index.ts`):
```typescript
export interface StatusJson {
  updated_at: string;          // ISO
  daemon_alive: boolean;
  ctx_tokens_used: number;
  ctx_tokens_budget: number;
  decisions_in_scope: number;
  invariants_in_scope: number;
  task_state: "idle" | "running" | "queued" | "tightening" | "sensing" | "reviewing" | "backprop";
  task_module: string | null;
  gc_running: boolean;
  attention_count: number;
  last_run_result: "succeeded" | "failed" | null;
  last_run_at: string | null;
}
```

**Notes for the subagent:**
- `exactOptionalPropertyTypes` applies — when merging `patch` over existing state, preserve `null` vs missing distinctions.
- The 10ms perf budget in the spec is aspirational; don't add IPC, just do the file read.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `cd harness && npx tsc --noEmit` passes.
- `harness status-line` runs in this repo without throwing (outputs the placeholder string since no state file exists yet).
- `import { readStatusForCLI } from "@devplusllc/harness-core"` resolves cleanly.

---

### TASK 3 — Context module: handoff builder + spec delta

**READ FIRST:**
- `docs/CONTEXT_CONTINUITY_SPEC.md` (full file — note both §2.2 handoff format AND new §10 spec delta)
- `packages/harness-core/src/ground/ledgers.ts` (existing reader patterns)
- `packages/harness-core/src/session-start/build.ts` (existing context builder — `parseFrontmatter` import, section-rendering pattern)
- `packages/harness-core/src/gc/sweep.ts` (lines 16-30 + 184 — actual `simpleGit` usage in this codebase)
- `packages/harness-core/src/index.ts` (the public barrel)

**Context to paste:** Full content of all five files.

**Files to create:**
- `packages/harness-core/src/context/handoff-builder.ts` — exports `async function buildHandoffBlock(repoRoot: string): Promise<string | null>`. The function:
  1. Lists `.harness/tasks/active/*/`. If none, returns `null`.
  2. For each active task, reads `status.yaml` to find a `phase` of `running`/`sensing` and a linked `run_id` (look at status.yaml `related_run_ids[0]` per FILESYSTEM_LAYOUT.md §6.3). If no linked run found across tasks, returns `null`.
  3. For the matched task, reads `runs/active/<run_id>/meta.json` to get `sha_pin`. If missing, returns `null`.
  4. Uses `simpleGit({ baseDir: repoRoot })` (async) to call `git.log({ from: shaPin, to: "HEAD" })` for commit messages and `git.diffSummary([shaPin, "HEAD"])` for files-touched stats.
  5. Reads `tasks/active/<id>/spec.tightened.md` for `checkpoints:` frontmatter (best-effort; missing → omit phases section).
  6. Reads `tasks/active/<id>/notes.md` if present (best-effort; missing → omit notes section).
  7. Renders the handoff block string per §2.2 of CONTEXT_CONTINUITY_SPEC, capped at ~2400 chars (~600 tokens). Truncate the commit list to the 20 most recent if needed; truncate notes oldest-first.
- `packages/harness-core/src/context/checkpoint.ts` — exports `async function writeCheckpoint(repoRoot: string, taskId: string, runId: string): Promise<string>`. Writes `.harness/tasks/active/<taskId>/checkpoint-<ISO-timestamp>.md` containing the same content `buildHandoffBlock` would render for that run. Returns the absolute path written. Used by the daemon at 75% context (no daemon wiring in this task).
- `packages/harness-core/src/context/spec-delta.ts` — exports `async function buildSpecDelta(repoRoot: string, taskScopePaths: string[]): Promise<SpecDelta | null>`. Implements the computation in CONTEXT_CONTINUITY_SPEC §10.2:
  1. If `taskScopePaths` is empty → return `null` (caller didn't tell us what's in scope; bail rather than guess).
  2. Cap `taskScopePaths` at 100 entries (keep `git log` cheap).
  3. For each path, run `git.log({ file: path, maxCount: 1, format: { sha: "%H" } })` (or equivalent shape — use the simple-git pattern actually in `gc/sweep.ts`). Take the MIN-by-author-date of the resulting SHAs as the cutoff. If no commits found for any path, return `null` (file is brand-new — no delta to compute).
  4. Read `decisions.ledger.yaml` and `invariants.ledger.yaml` at the cutoff SHA via `git.show([\`\${cutoff}:.harness/ground/decisions/decisions.ledger.yaml\`])` (handle `not in tree` gracefully → empty array). Same for invariants.
  5. Read the same two ledgers at HEAD via direct file read.
  6. Compute the diff: decisions added/superseded since cutoff whose `scope_globs` overlap any task path; invariants added/superseded since cutoff whose `source_decision`'s scope overlaps. (Glob-overlap check: reuse `matchAnyGlob` from `ground/glob.js`.)
  7. Also stat brand/product files (`brand/overview.md`, `brand/voice.md`, `product/positioning.md`, `product/personas.yaml`) — flag any whose mtime is newer than the cutoff commit's date. Emit as separate `brand` field in the result.
  8. If no decisions changed AND no invariants changed AND no brand changed → return `null` (empty delta = no injection).
  9. Otherwise return a `SpecDelta` object with structured fields the tightener integration can render.
- `packages/harness-core/src/context/index.ts` — barrel re-exporting `buildHandoffBlock`, `writeCheckpoint`, `buildSpecDelta`, and the `SpecDelta` type.

**SpecDelta type** (export from `context/index.ts`):
```typescript
export interface SpecDelta {
  cutoffSha: string;            // 7-char short SHA
  cutoffAgeDays: number;        // floor((now - cutoffDate) / 86400000)
  scopeSummary: string;         // human-readable, e.g. "src/auth/" or "5 paths"
  decisions: {
    added: { id: string; title: string; scopeGlobs: string[] }[];
    superseded: { id: string; supersededBy: string; title: string }[];
  };
  invariants: {
    added: { id: string; title: string; sourceDecision: string | null }[];
    superseded: { id: string; supersededBy: string; title: string }[];
  };
  brand: { path: string; mtimeIso: string }[];   // brand/product files newer than cutoff
}
```

**Files to modify:**
- `packages/harness-core/src/index.ts` — add `export * from "./context/index.js";` near the other subdir re-exports.

**Handoff block format** (verbatim shape from CONTEXT_CONTINUITY_SPEC §2.2 — render exactly):
```
## ⟳ Resuming run TSK-<id> — <task-title>

Commits since run start:
  <sha7>  <subject>
  ...

Phases complete: <from checkpoints if frontmatter present>
Phases remaining: <from checkpoints if frontmatter present>

Files touched so far:
  <path>  [+N -N]
  ...

Agent notes from previous phases:
  <content of notes.md, if any>
```

If checkpoints frontmatter absent: omit the two "Phases" lines entirely.
If notes.md absent: omit the "Agent notes" section.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `buildHandoffBlock(repoRoot)` on a repo with no `.harness/tasks/active/` returns `null` (verified by smoke in Task 13).
- `buildSpecDelta(repoRoot, [])` returns `null`. `buildSpecDelta(repoRoot, ["src/foo.ts"])` on a new file with no git history returns `null`.
- `import { buildHandoffBlock, buildSpecDelta, type SpecDelta } from "@devplusllc/harness-core"` resolves cleanly.

---

### TASK 4 — Session-start Section 0 (handoff injection)

**READ FIRST:**
- `docs/SESSIONSTART_SPEC.md` (§ "Section 0 — Run handoff (highest priority…")
- `docs/CONTEXT_CONTINUITY_SPEC.md` (§4 session resume detection, §9 relationship)
- `packages/harness-core/src/session-start/build.ts` (FULL FILE — you will modify this)

**Context to paste:** Full content of all three files. Also paste the entire current `dropPriority` array verbatim from `build.ts` so the subagent knows the actual data structure.

**Goal:** Add a new highest-priority section `run_handoff` that gets injected as the FIRST section when an active run with prior commits is detected. The existing `buildSessionStartContext` is now `sync`; this task makes it `async` so it can `await buildHandoffBlock(...)`.

**Note about `dropPriority`:** Despite earlier drafts referring to a "never-drop set," the current code has no such set. Truncation is governed by a single `dropPriority` array whose **last** element is dropped last (i.e. `header` is the most-protected). The subagent must add `run_handoff` as the LAST element of `dropPriority` and as the FIRST element of `orderedSections`.

**Files to modify:**
- `packages/harness-core/src/session-start/build.ts`

**Changes:**
1. Add `"run_handoff"` to the `SessionStartSection` union (alongside `"header"`, `"two_zone_reminder"`, etc.).
2. Change `buildSessionStartContext` to `async` and update its return type to `Promise<BuildSessionStartContextResult>`.
3. Near the start of `buildSessionStartContext`, after parsing args:
   ```ts
   let runHandoffSection: string | null = null;
   if (args.source === "resume" || args.source === "compact" || args.source === "startup") {
     try {
       runHandoffSection = await buildHandoffBlock(args.repoRoot);
     } catch (err) {
       warnings.push(`handoff builder failed: ${err instanceof Error ? err.message : String(err)}`);
     }
   }
   ```
   Import via `import { buildHandoffBlock } from "../context/index.js";`.
4. When `runHandoffSection !== null`, prepend `{ id: "run_handoff", body: runHandoffSection }` to `orderedSections` BEFORE the `header` push.
5. Append `"run_handoff"` to the END of the `dropPriority` array (so it is the absolutely-last thing dropped, even after `header`).

**Caller updates (REQUIRED — this is a breaking signature change):**
Search the codebase for all call sites:
```bash
grep -rn "buildSessionStartContext" packages/ harness/ --include="*.ts" | grep -v node_modules | grep -v dist
```
Every caller (the SessionStart hook in `harness/src/cli/hook.ts`, plus `harness/scripts/smoke-session-start.ts`) currently calls it synchronously. Update each to `await` the result. The hook function `sessionStartHook()` is already `async`, so just add `await`. The smoke is a `runSmoke()` function that should also become `async` (or have its callers `await runSmoke()`).

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `cd harness && npx tsc --noEmit` passes.
- The existing `smoke-session-start` still passes (`pnpm smoke:session-start` in `harness/`).
- When source is `"resume"` or `"compact"` AND an active run with commits exists, `run_handoff` appears first in `sectionsRendered`.
- When no active run exists, `sectionsRendered` is unchanged from current behavior.

---

### TASK 4b — Session-start: brand + product positioning injection

**READ FIRST:**
- `docs/PRIMER.md` §3 (ground state taxonomy — `brand/`, `product/`)
- `docs/DOCS_SPEC.md` §3.3 (brand), §3.4 (product), §5.5 (always-injected table)
- `packages/harness-core/src/session-start/build.ts` (FULL FILE post-Task-4)
- `packages/harness-core/src/session-start/templates.ts` (FULL FILE post-Task-1)

**Context to paste:** Full content of all four files.

**Goal:** PRIMER §3 and DOCS_SPEC §5.5 mandate `brand/overview.md` and `product/positioning.md` injected at every SessionStart, regardless of task type. Task 8 will create the stubs; this task wires the injection so the seeded files actually reach the agent's context.

**Files to modify:**
- `packages/harness-core/src/session-start/build.ts` — add a new `"brand_and_positioning"` section.

**Changes:**
1. Add `"brand_and_positioning"` to the `SessionStartSection` union.
2. Add a small reader function:
   ```ts
   function readBrandAndPositioning(repoRoot: string, warnings: string[]): string | null {
     const brandPath = join(repoRoot, ".harness", "ground", "brand", "overview.md");
     const positioningPath = join(repoRoot, ".harness", "ground", "product", "positioning.md");
     const parts: string[] = [];
     for (const [label, path] of [
       ["Brand overview", brandPath] as const,
       ["Product positioning", positioningPath] as const,
     ]) {
       if (!existsSync(path)) continue;
       try {
         const text = readFileSync(path, "utf8");
         const parsed = parseFrontmatter(text);
         const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
         const status = typeof fm["status"] === "string" ? fm["status"] : null;
         const body = parsed.body.trim();
         if (body.length === 0) continue;
         const draftHint = status === "draft" ? "  [DRAFT — operator has not filled this in; ask before making design decisions]" : "";
         parts.push(`### ${label}${draftHint}\n\n${body}`);
       } catch (err) {
         warnings.push(`${label} read failed: ${err instanceof Error ? err.message : String(err)}`);
       }
     }
     if (parts.length === 0) return null;
     return `## Brand and product context\n\n${parts.join("\n\n")}`;
   }
   ```
3. Call it in `buildSessionStartContext` after the existing readers, capture into a `brandAndPositioningSection` local.
4. Insert it into `orderedSections` AFTER `header` and `two_zone_reminder` but BEFORE `tool_quick_reference`. Also push it BEFORE `current_task` and the rest.
5. Insert `"brand_and_positioning"` into `dropPriority` near the lower-priority end (drop before `current_task` but after `quality_grades_tail` and `pending_drafts`). Concretely, place it between `pending_drafts` and `invariants_active`.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `cd harness && npx tsc --noEmit` passes.
- The existing `smoke-session-start` still passes.
- A new fixture with `brand/overview.md` and `product/positioning.md` populated produces a `brand_and_positioning` entry in `sectionsRendered` and the body text appears in `additionalContext` (extend `smoke-session-start.ts` minimally to verify this).
- A fixture WITHOUT those files produces no `brand_and_positioning` section and no warnings.

---

### TASK 5 — PostToolUse read enricher

**READ FIRST:**
- `docs/READ_ENRICHER_SPEC.md` (§1 through §11, the "Read Enricher" section — including §6.1 scope-index integration)
- `packages/harness-core/src/ground/ledgers.ts` (ledger data structures)
- `packages/harness-core/src/index.ts` (the public barrel)
- `harness/src/cli/hook.ts` (FULL FILE — you will add a new case)

**Context to paste:** Full content of all four files.

**IMPORTANT — verify the PostToolUse payload shape before writing the parser.**
The READ_ENRICHER_SPEC.md lists the input as `{ tool_name, tool_input: { file_path }, tool_response: { content } }`, but Claude Code's actual SessionStart payload (visible in `harness/src/cli/hook.ts`) carries additional fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`); the same is true for PostToolUse. The Read tool's `tool_response` may also be a structured object (not a bare `{ content }`) and may format file content with `cat -n`-style line-number prefixes.

The subagent MUST:
1. Define a `ClaudePostToolUsePayload` interface that includes the additional standard fields, marked optional, so unknown fields don't fail JSON parsing.
2. Define `tool_response` as `{ content?: string; text?: string; output?: string; [key: string]: unknown }` and pick the first non-empty string field present.
3. Strip a leading `\d+\t` (tab-separated line-number prefix) from each line ONLY when computing `line` numbers in the legend — do not modify the body text the agent sees.
4. Defer-fail gracefully: if the payload doesn't match any expected shape, write the original input back to stdout and exit 0 (the hook is a no-op enrichment, NOT a gate).

This is the highest-risk uncertainty in the build. If the assumption is wrong the legend is rendered against malformed text and citations don't resolve. The fallback to "exit 0 with passthrough on any unrecognized shape" keeps the session safe regardless.

**Files to create:**
- `packages/harness-core/src/hooks/post-tool-use/citation-scanner.ts` — exports `function scanCitations(content: string): { invariants: { id: string; line: number }[]; todos: { id: string; line: number }[]; decIds: { id: string; line: number }[] }` using regex: `§V(\d+)`, `TODO\(TSK-([^)]+)\)`, `DEC-(\d+)`. Strip line-number prefixes (`/^\s*\d+\t/`) before scanning so the matched line numbers are correct in either raw or `cat -n` formatted content. The `decIds` array exists ONLY for the policy-violation legend — they are NOT enriched as live citations.
- `packages/harness-core/src/hooks/post-tool-use/legend-builder.ts` — exports `function buildLegend(matches: ScannedCitations, ledger: LedgerData, scopeEntry: ScopeIndexEntry | null): string | null`. Returns the formatted legend block string or `null` if no citations found AND no scope-index entry. When `scopeEntry` has decisions/invariants, prepend the "Decisions in scope / Invariants in scope" header per READ_ENRICHER_SPEC.md §6.1.
- `packages/harness-core/src/hooks/post-tool-use/ledger-cache.ts` — in-process LRU (max 1 entry each) cache for `invariants.ledger.yaml`, `decisions.ledger.yaml`, AND `scope-index.yaml`, each keyed by `repoRoot + mtime`. Use `parseYaml` from `yaml`. Also reads `tasks/active/*/status.yaml` and `tasks/done/*/attestation.yaml` for `TODO(TSK-)` resolution (done tasks → "DONE — this TODO can be removed"; missing → "NOT FOUND"). The scope-index reader is reused by the write guardian (Task 6) — export it cleanly so Task 6 doesn't reinvent it.
- `packages/harness-core/src/hooks/post-tool-use/read-enricher.ts` — entry point `async function runReadEnricher(): Promise<void>`. Reads stdin, parses payload (gracefully), resolves `repoRoot` via the SessionStart hook's existing `resolveRepoRoot` helper (re-export from `session-start/build.ts` if needed), scans content, looks up `repoRelativeFilePath` in the scope-index, builds legend (with optional in-scope header), prepends to content, writes Shape-B response to stdout. Exit 0 always — uncaught exceptions write the original content unmodified and still exit 0.
- `packages/harness-core/src/hooks/post-tool-use/index.ts` — barrel re-exporting `runReadEnricher`, the citation scanner, and the ledger cache reader (so Task 6 can import).

**Files to modify:**
- `packages/harness-core/src/index.ts` — add `export * from "./hooks/post-tool-use/index.js";`
- `harness/src/cli/hook.ts` — add `case "read-enrich":` that calls `await runReadEnricher();`. Update the file's leading docblock comment to list the new event. Update the `usage()` block:
  ```
  Usage: harness hook <event>
    session-start    SessionStart hook (default)
    read-enrich      PostToolUse on Read — citation legend enricher
  ```
- `harness/src/cli/index.ts` — update the `usage()` block's `hook` line: `hook       Claude Code hook runner (subcommands: session-start | read-enrich | write-guard)`.

**Hook output shape (Shape B):**
```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<legend block>"
  }
}
```

NOTE: Use `additionalContext` — that field IS part of Claude Code's documented hook output contract for prepending content to the agent's view. The `modified_tool_response` field in earlier spec drafts is NOT a documented Claude Code hook field; do not emit that. The legend prepended via `additionalContext` accomplishes the same effect: the agent sees the legend before/with the file content.

**Legend format (with scope-index integration):**
```
┌─ harness citations ──────────────────────────────────────┐
│ Decisions in scope: DEC-0042, DEC-0089                   │
│ Invariants in scope: §V0041, §V0052                      │
│ §V0023  → null-check before array destructure  [active]  │
│ §V0041  → [SUPERSEDED by §V0042 — update this citation]  │
│ §V9999  → [NOT FOUND — orphaned citation, GC will flag]  │
│ TODO(TSK-auth) → bearer token validation  [active]       │
│ DEC-0023 → [POLICY VIOLATION — DEC-id comments banned]   │
└──────────────────────────────────────────────────────────┘
```

The "in scope" header lines are added only when the file's scope-index entry has non-empty decisions/invariants arrays. Otherwise omitted (no overhead).

**Skip rules:**
- `content.length > 512_000` → skip enrichment, pass through.
- File path matches `.archive/**` or `.harness/ground/**` → skip enrichment.
- `repoRoot` resolves to `null` (not under a `.harness/` ancestor) → skip enrichment.
- Binary content (UTF-8 decode fails or contains a high density of non-printable chars) → skip enrichment.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `cd harness && npx tsc --noEmit` passes.
- On stdin with a file containing no citations AND no scope-index entry, stdout `additionalContext` is empty/null and the legend block is not emitted.
- No MCP calls from within the enricher.
- `import { runReadEnricher } from "@devplusllc/harness-core"` resolves cleanly.

---

### TASK 6 — PostToolUse write guardian + sensors.yaml extension

**READ FIRST:**
- `docs/READ_ENRICHER_SPEC.md` (§ "Write Guardian" section, including "Scope-index integration")
- `packages/harness-core/src/hooks/post-tool-use/read-enricher.ts` (from Task 5 — same stdin/stdout pattern; reuse the scope-index reader from `ledger-cache.ts`)
- `packages/harness-core/templates/.harness/config/sensors.yaml` (FULL FILE — extension target)
- `packages/harness-core/src/index.ts` (the public barrel)

**Context to paste:** Full content of all four files plus the spec section.

**Goal:** A PostToolUse hook on `Write` and `Edit` that scans new content for internal-pattern leakage in user-facing strings, ALSO does an O(1) scope-index lookup against `.harness/ground/scope-index.yaml`, and appends a warning to the tool result via `additionalContext` when either signal is hot. Also extend the `sensors.yaml` template with the `copy_safety:` configuration block.

**Files to create:**
- `packages/harness-core/src/hooks/post-tool-use/copy-scanner.ts` — exports `function scanForCopyLeakage(content: string, filePath: string): CopyIssue[]`. Pattern set:
  - `\b(TODO|FIXME|HACK|XXX|TEMP|WIP)\b` (comment markers leaking into strings)
  - `§V\d+` and `\bTSK-[a-z0-9-]+\b` (harness citations in user copy)
  - `\[(PLACEHOLDER|TODO|DRAFT)\]` (draft markers)
  - `\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b` (multi-underscore identifiers)
  - `(^|[\s"'`])(src/|packages/|\.harness/)` (internal path strings)
  Returns `CopyIssue[]` with `{ line: number, match: string, pattern: string }`.
  For `.tsx`/`.jsx` files, scan only inside JSX text positions and template-string content using a lightweight regex-based string-literal extractor (not a full AST — keep the dep surface zero). For `.json` files (i18n), scan only string values. For `.html`/`.vue`/`.svelte`, scan everywhere — the guardian's whole job is to be a fast warning, not a perfect filter.
- `packages/harness-core/src/hooks/post-tool-use/allowlist-reader.ts` — reads `.harness/config/sensors.yaml`'s `copy_safety` section, returns `{ enabled: boolean; globs: string[]; allowlist: string[] }`. Falls back to a hardcoded default when the section is missing.
- `packages/harness-core/src/hooks/post-tool-use/write-guardian.ts` — entry point `async function runWriteGuardian(): Promise<void>`. Reads stdin, parses payload (same graceful pattern as Task 5), checks if `tool_input.file_path` matches any `globs` from `allowlist-reader`. Behavior:
  1. If glob match → run `scanForCopyLeakage` against the new content (`tool_response.content` for Write; for Edit, fall back to `tool_input.new_string` if `tool_response` is empty), filter against `allowlist`. Capture issues.
  2. ALWAYS look up `tool_input.file_path` in scope-index (regardless of glob match). Capture decisions/invariants.
  3. If issues OR scope-index hit: emit Shape-B response with the assembled warning block in `additionalContext`. The block has a copy-safety section (when issues found) AND a scope-index section (when in-scope decisions/invariants found).
  4. If neither: pass through, empty `additionalContext`.
  5. Exit 0 always.

**Files to modify:**
- `packages/harness-core/templates/.harness/config/sensors.yaml` — append a new section near the end (BEFORE `disabled_per_project:`):
  ```yaml
  
  # ──────────────────────────────────────────────────────────────────────────────
  # Copy-safety configuration (write guardian + Layer D sensor)
  #
  # The write guardian (PostToolUse hook on Write/Edit) and the Layer D
  # copy-safety sensor both consume this block. Globs default to common frontend
  # file extensions; extend per-project as needed. allowlist holds verbatim
  # strings that match a pattern but are intentional (technical error codes,
  # product names, etc.).
  # ──────────────────────────────────────────────────────────────────────────────
  
  copy_safety:
    enabled: true
    globs:
      - "src/**/*.tsx"
      - "src/**/*.jsx"
      - "src/**/*.vue"
      - "src/**/*.svelte"
      - "**/*.html"
      - "src/**/i18n/**/*.json"
      - "src/**/locales/**/*.json"
    allowlist: []
  ```
- `packages/harness-core/src/index.ts` — `runWriteGuardian` re-exported via the same `hooks/post-tool-use/index.js` barrel (extend Task 5's barrel).
- `harness/src/cli/hook.ts` — add `case "write-guard":` calling `await runWriteGuardian();`. Update docblock + `usage()` block to mention `write-guard`.

**Combined warning block (Shape B):**
```
⚠ harness:copy-safety — N potential internal copy issue(s) in <filename>:
  line N  "<match>"  → <pattern> in user-facing string

ℹ harness:scope — this file has rules in scope:
  decisions: DEC-0042, DEC-0089
  invariants: §V0041, §V0052

Write succeeded. Review before committing.
```

Either section is omitted if its corresponding signal is empty.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `cd harness && npx tsc --noEmit` passes.
- Files outside `copy_safety.globs` AND with no scope-index entry pass through unchanged (empty `additionalContext`).
- Files inside the globs with no issues but with a scope-index entry produce a scope-only warning.
- `sensors.yaml` template now contains a `copy_safety:` section.

---

### TASK 7 — Init: register PostToolUse hooks in the settings.json TEMPLATE

**READ FIRST:**
- `packages/harness-core/templates/.claude/settings.json` (FULL FILE — only 14 lines)
- `packages/harness-core/src/init/seed.ts` (FULL FILE — to confirm the template is copied verbatim by `seedHarnessLayout`)
- `docs/READ_ENRICHER_SPEC.md` §2 (hook registration)
- `docs/PRIMER.md` §8.6 (hook priority order)

**Context to paste:** Full content of all four files.

**IMPORTANT — earlier draft of this task was wrong.** It instructed editing `init.ts` to write hooks programmatically. In reality, `init.ts` does NOT write `.claude/settings.json` directly. The file is shipped as a **template** at `packages/harness-core/templates/.claude/settings.json` and copied verbatim by `seedHarnessLayout` (see `src/init/seed.ts`). The fix is to edit the template; `seed.ts` handles the rest.

**Files to modify:**
- `packages/harness-core/templates/.claude/settings.json`

**New template content:**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @devplusllc/harness hook session-start"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @devplusllc/harness hook read-enrich"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @devplusllc/harness hook write-guard"
          }
        ]
      },
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @devplusllc/harness hook write-guard"
          }
        ]
      }
    ]
  }
}
```

Note: the `command` strings use `npx -y @devplusllc/harness` (matching the existing SessionStart entry's pattern), NOT the bare `harness` from earlier drafts. This ensures consistency for fresh adoptions where `harness` may not yet be on PATH.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes (no code changes — template-only).
- `node -e "JSON.parse(require('node:fs').readFileSync('packages/harness-core/templates/.claude/settings.json', 'utf8'))"` succeeds (valid JSON).
- The file contains exactly one `SessionStart` array entry and three `PostToolUse` entries (Read, Write, Edit), each invoking `npx -y @devplusllc/harness hook <event>`.

---

### TASK 8 — Init: seed brand/product/capabilities ground state via templates

**READ FIRST:**
- `docs/DOCS_SPEC.md` §3.3 (brand), §3.4 (product), §3.5 (capabilities), §8 (ground state seeding at init)
- `packages/harness-core/src/init/seed.ts` (FULL FILE)
- `packages/harness-core/templates/` listing — directory tree:
  ```
  packages/harness-core/templates/.archive/README.md
  packages/harness-core/templates/.claude/settings.json
  packages/harness-core/templates/.harness/config/sensors.yaml
  packages/harness-core/templates/.harness/config/stub-patterns.yaml
  packages/harness-core/templates/.harness/config/trust-policy.yaml
  packages/harness-core/templates/.harness/config/workflow.md
  packages/harness-core/templates/.harness/ground/canonical-map/topics.yaml
  packages/harness-core/templates/.harness/ground/manifest.yaml
  packages/harness-core/templates/.mcp.json
  packages/harness-core/templates/README.md
  ```

**Context to paste:** Full content of seed.ts + the spec sections + the templates directory listing above.

**Goal:** PRIMER §3 / DOCS_SPEC §3.3-3.5 require seeding `brand/`, `product/`, and `capabilities/` stubs at init time so the SessionStart brand+positioning injection (Task 4b) and the Layer F research gate have something to load. The cleanest approach — consistent with how everything else is templated — is to add the stubs under `templates/.harness/ground/`. `seedHarnessLayout` already walks `templates/` and skips collisions when `force` is not set, so existing operator content is automatically preserved.

**Files to create (in `packages/harness-core/templates/.harness/ground/`):**

1. `brand/overview.md`:
   ```markdown
   ---
   type: rule
   status: draft
   audience: dual
   generated: 2026-05-04T00:00:00Z
   verified-at: 2026-05-04T00:00:00Z
   source-commits:
     - manual
   ---
   
   # Brand overview
   
   <!--
   Fill this in. This file is injected at every SessionStart so the AI knows
   what your product looks and sounds like before it makes design decisions.
   Keep it short — one paragraph max, < 200 tokens. Cover: product personality,
   tone, what to avoid. Detailed colors/typography go in colors.yaml /
   typography.yaml.
   
   While status is `draft`, the AI will see a [DRAFT] hint in its context and
   ask before making design decisions. Flip status to `accepted` once filled.
   -->
   
   (operator: replace this paragraph with your brand summary)
   ```

2. `product/positioning.md`:
   ```markdown
   ---
   type: rule
   status: draft
   audience: dual
   generated: 2026-05-04T00:00:00Z
   verified-at: 2026-05-04T00:00:00Z
   source-commits:
     - manual
   ---
   
   # Product positioning
   
   <!--
   Fill this in. This file is injected at every SessionStart so the AI knows
   what the product is and isn't. Keep it short — < 300 tokens. Cover: who
   this is for, the core value, what's deliberately out of scope.
   
   Flip status to `accepted` once filled.
   -->
   
   (operator: replace this paragraph with a tight positioning statement)
   ```

3. `capabilities/skills.yaml`:
   ```yaml
   # Installed skill packs available in this session.
   # The init mapper scans .claude/skills/ and seeds entries; operator extends.
   skills: []
   ```

4. `capabilities/mcp-tools.yaml`:
   ```yaml
   # MCP servers registered alongside harness in .mcp.json.
   # Includes name + description so the agent knows what's available without
   # listing every tool exhaustively.
   mcp_tools: []
   ```

5. `capabilities/snippets.yaml`:
   ```yaml
   # Blessed implementations for security-sensitive patterns.
   # See DOCS_SPEC.md §3.5 for shape.
   snippets: []
   ```

**No code changes to `seed.ts`.** `seedHarnessLayout` already walks the templates dir and copies everything; the existing `applyPlaceholders` no-ops on these new files (correct — they don't need slug substitution).

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- The five new files exist under `packages/harness-core/templates/.harness/ground/`.
- A test invocation of `seedHarnessLayout` against a fresh temp dir produces all five files at the expected paths under `.harness/ground/`.

---

### TASK 9 — Scope index: type, init seed, hook integration, GC pass stub

**READ FIRST:**
- `docs/DOCS_SPEC.md` §3.8 "Scope index" (full subsection)
- `docs/INIT_SPEC.md` §3 (mapper output — `MapperProposal` + new `ScopeIndexProposal` interface)
- `docs/READ_ENRICHER_SPEC.md` §6.1 (Read enricher scope-index integration) + Write Guardian "Scope-index integration"
- `docs/CONTEXT_CONTINUITY_SPEC.md` §10.2 step 1 (spec delta uses scope-index reverse lookup)
- `packages/harness-core/src/init/mapper.ts` (FULL FILE — extend `MapperOutput` zod schema + JSON Schema)
- `packages/harness-core/src/init/init.ts` (FULL FILE — add scope-index.yaml write step in Phase 5 / `runInit`)
- `packages/harness-core/src/init/seed.ts` (FULL FILE — confirm template-copy boundary; this task adds a runtime write, not a template)
- `packages/harness-core/src/hooks/post-tool-use/ledger-cache.ts` (from Task 5 — reuse the cache pattern)
- `packages/harness-core/src/gc/types.ts` (post Tasks 10 + 11 — already extended; this task adds `"scope-coverage"`)
- `packages/harness-core/src/gc/sweep.ts` (post Tasks 10 + 11 — already extended)

**Dependencies:** Tasks 3, 5, 6, 8 must be complete. The scope-index reader is reused by the Read enricher (Task 5 ledger-cache) and Write guardian (Task 6); the spec-delta module (Task 3) optionally uses scope-index for reverse lookup; Task 8's template seeding establishes the convention this task extends.

**Context to paste:** Full content of all listed files plus the spec sections.

**Goal:** Wire scope-index end-to-end. Five concrete additions, one per layer.

**Files to create:**

- `packages/harness-core/src/ground/scope-index.ts` — exports the canonical types and a reader:
  ```ts
  export interface ScopeIndexEntry {
    decisions: string[];
    invariants: string[];
    unscoped?: true;
  }
  
  export interface ScopeIndex {
    generated: string;          // ISO
    files: Record<string, ScopeIndexEntry>;
  }
  
  export function scopeIndexPath(repoRoot: string): string;     // <repoRoot>/.harness/ground/scope-index.yaml
  export function readScopeIndex(repoRoot: string): ScopeIndex | null;   // null if missing/unparseable
  export function lookupScope(index: ScopeIndex, repoRelativePath: string): ScopeIndexEntry | null;
  export function writeScopeIndex(repoRoot: string, index: ScopeIndex): void;
  ```
- `packages/harness-core/src/gc/scope-coverage.ts` — exports `function runScopeCoverage(opts: { repoRoot: string }): { findings: GcFinding[] }`. Stub-quality logic for v1:
  1. Load scope-index via `readScopeIndex`. If null → emit a single `kind: "scope_index_missing"` finding with `severity: "warn"` and return.
  2. Walk source files via the same `walkSourceTree` Task 11 (citation integrity) extracted/duplicated. For each file: if `lookupScope(index, relPath)` is `null` AND `entry?.unscoped !== true`, emit `kind: "scope_uncovered"` finding (`severity: "warn"`).
  3. For each entry in the index: stat the file. If missing, emit `kind: "scope_drift_orphan"` (`severity: "warn"`).
  
  Cap findings at 50 per kind to avoid attention-queue floods on first-run unindexed repos.

**Files to modify:**

- `packages/harness-core/src/init/mapper.ts` — extend `MapperOutput` zod schema (and JSON Schema, if defined separately) to include `scope_index` field with shape `{ files: Record<string, { decisions: string[]; invariants: string[]; unscoped?: boolean }> }`. The mapper LLM does NOT need to populate this on first run — it can return an empty `{ files: {} }`. The OPERATOR seeds the index manually or via `harness scope rebuild` (out of scope for this build). Update `validateMapperOutput` to accept the new field with a `.default({ files: {} })` so older mappers don't break.

- `packages/harness-core/src/init/init.ts` — in `runInit`, after the Phase 5 / Step 3 "Writing .harness/config.yaml" block, add a new step "Writing .harness/ground/scope-index.yaml":
  ```ts
  // ── Step 3b: scope-index.yaml ──────────────────────────────────────
  const scopeIndexFile = scopeIndexPath(repoRoot);
  if (existsSync(scopeIndexFile) && args.force !== true) {
    warnings.push(".harness/ground/scope-index.yaml already exists — kept existing");
    done(`= .harness/ground/scope-index.yaml (kept)`);
  } else {
    const seed: ScopeIndex = {
      generated: new Date().toISOString(),
      files: mapperOutput?.scope_index?.files ?? {},
    };
    mkdirSync(dirname(scopeIndexFile), { recursive: true });
    writeScopeIndex(repoRoot, seed);
    done(`+ .harness/ground/scope-index.yaml`);
  }
  ```
  Imports: `import { scopeIndexPath, writeScopeIndex, type ScopeIndex } from "../ground/scope-index.js";`

- `packages/harness-core/src/hooks/post-tool-use/ledger-cache.ts` — extend the cache to also load and cache the scope-index. Add a `function getScopeIndexEntry(repoRoot: string, repoRelativePath: string): ScopeIndexEntry | null` accessor. Used by both the Read enricher (Task 5) and the Write guardian (Task 6). Both already declare a dependency on this cache; this task wires the new accessor into both.

- `packages/harness-core/src/hooks/post-tool-use/legend-builder.ts` (from Task 5) and `packages/harness-core/src/hooks/post-tool-use/write-guardian.ts` (from Task 6) — confirm both call `getScopeIndexEntry` correctly. Tasks 5 and 6 already wire the call sites; this task validates the integration end-to-end after `getScopeIndexEntry` exists.

- `packages/harness-core/src/gc/types.ts` —
  - Add `"scope-coverage"` to `GcPassId`.
  - Add `"scope_uncovered"`, `"scope_drift_orphan"`, `"scope_index_missing"` to `GcFindingKind`.

- `packages/harness-core/src/gc/sweep.ts` —
  - Import `runScopeCoverage` from `./scope-coverage.js`.
  - Add `"scope-coverage": 0` to the `passDurations` initializer.
  - Add an eighth pass block after pass 7 (citation integrity) wrapping `runScopeCoverage`.

- `packages/harness-core/src/index.ts` — add `export * from "./ground/scope-index.js";` near the other ground re-exports.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `cd harness && npx tsc --noEmit` passes.
- A fresh `runInit({ skipMirror: true, skipMapper: true, mockMapperOutput: undefined })` against a temp dir produces `.harness/ground/scope-index.yaml` with `files: {}`.
- `runScopeCoverage({ repoRoot })` against a repo with no scope-index returns a single `scope_index_missing` finding.
- `runScopeCoverage({ repoRoot })` against a repo with a populated scope-index walks source files and emits coverage gaps as `scope_uncovered`.
- The Read enricher and Write guardian, when invoked against a file with a scope-index entry, include the "Decisions in scope" / "Invariants in scope" lines in the legend / warning per Tasks 5+6.

---

### TASK 10 — GC: completion integrity pass

**READ FIRST:**
- `docs/DOCS_SPEC.md` §7 "Completion integrity" pass (the new pass)
- `docs/FILESYSTEM_LAYOUT.md` §6 (task file shapes — `tasks/active/<id>/status.yaml`) and §7 (run file shapes — `runs/active/<run-id>/{meta.json,attestation.yaml,sensor-results.yaml}`)
- `packages/harness-core/src/gc/types.ts` (FULL FILE — extend `GcPassId` and `GcFindingKind`)
- `packages/harness-core/src/gc/sweep.ts` (FULL FILE — add a sixth pass; note the `passDurations` map lists every pass id and must include the new one)
- `packages/harness-core/src/gc/stub-hits.ts` (pattern reference for a pass module)

**Context to paste:** Full content of all five files plus the spec section.

**IMPORTANT — earlier draft was wrong about file locations.** That draft told the subagent to read `tasks/done/<id>/attestation.yaml` and check a `git_sha` field. Per FILESYSTEM_LAYOUT §7.1 + §7.3:
- `attestation.yaml` lives in `.harness/runs/active/<run_id>/`, NOT `tasks/done/`. (When a run completes, the runs dir is moved to `runs/terminal/` per §7.)
- `attestation.yaml` carries `run_id`, `task_id`, `agent_role`, `emitted_at`, `delivered`, `files_touched`, `lines_added/removed` — there is NO `git_sha` field.
- The pin is `meta.json.sha_pin` in the same run dir.
- Sensor pass/fail is in `sensor-results.yaml` in the same run dir, NOT in attestation.
- A "done" task is one in `.harness/tasks/done/<task_id>/`. The linkage from done-task back to the run dir is via `status.yaml.related_run_ids` (last entry).

**Goal:** Add a sixth GC pass — `completion-integrity` — that, for every task in `tasks/done/`, validates the linked run directory exists with a passing attestation + sensor-results AND that the linked SHA is reachable in the current git history.

**Files to modify:**
- `packages/harness-core/src/gc/types.ts`
  - Add `"completion-integrity"` to the `GcPassId` union.
  - Add `"task_integrity_error"` to the `GcFindingKind` union.
- `packages/harness-core/src/gc/sweep.ts`
  - Import a new module `runCompletionIntegrity` from `./completion-integrity.js`.
  - Add a key `"completion-integrity": 0` to the `passDurations` initializer (otherwise TS will reject the literal type).
  - Add a sixth pass block after pass 5 (quality grades), wrapped in the same `t0`/`Date.now()` timing pattern.
- `packages/harness-core/src/gc/completion-integrity.ts` (new) — exports `async function runCompletionIntegrity(opts: { repoRoot: string }): Promise<{ findings: GcFinding[] }>`. Logic:
  1. List `.harness/tasks/done/*/`. For each:
  2. Read `status.yaml`. If `phase !== "succeeded"`, skip (it's there for another reason — e.g. archived in the wrong dir).
  3. Read `status.yaml.related_run_ids` (last entry as `runId`). If absent → emit a finding (`severity: "warn"`, `kind: "task_integrity_error"`, `detail: "task <id> in tasks/done/ has no related_run_ids"`).
  4. Look for the run dir in either `runs/active/<runId>/` or `runs/terminal/<runId>/`. If neither exists → finding "linked run dir not found".
  5. Read `meta.json` from the run dir. If missing or unparseable → finding "meta.json missing/malformed".
  6. Read `attestation.yaml`. If missing → finding "attestation.yaml missing".
  7. Read `sensor-results.yaml`. If any entry has `status !== "pass"` → finding "sensor failures present in completed task".
  8. Use `simpleGit({ baseDir: opts.repoRoot })` and `await git.catFile(["-e", meta.sha_pin])` (or equivalent — see `gc/sweep.ts` for the `simpleGit` import pattern). If the SHA isn't reachable → finding "attested SHA not found in git history".

  All findings have `pass: "completion-integrity"` and `severity: "warn"` (not `"block"` — completion-integrity surfaces problems but doesn't gate further work).

- `packages/harness-core/src/gc/index.ts` — re-export `runCompletionIntegrity` from `./completion-integrity.js` if there's a barrel pattern there; otherwise no change.

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `runCompletionIntegrity({ repoRoot })` against a repo with no `tasks/done/` returns `{ findings: [] }` (verified by smoke or quick repl test in the brief).
- `runGcSweep` returns a `pass_durations["completion-integrity"]` numeric entry.

---

### TASK 11 — GC: citation integrity pass

**READ FIRST:**
- `docs/DOCS_SPEC.md` §7 "Citation integrity" pass
- `packages/harness-core/src/gc/types.ts` (post Task 10 — already includes completion-integrity)
- `packages/harness-core/src/gc/sweep.ts` (post Task 10)
- `packages/harness-core/src/gc/stub-hits.ts` (FULL FILE — note especially the `walkSourceTree` function and `SKIP_DIRS` set)
- `packages/harness-core/src/hooks/post-tool-use/citation-scanner.ts` (from Task 5 — reuse the scanner)

**Context to paste:** Full content of all five files.

**IMPORTANT — use the right walker.** The earlier draft of this task said "use `walkCanonical` or similar git-tracked walk." But `walkCanonical` (in `ground/walk.ts`) only walks the canonical zone (docs + .harness/) and explicitly excludes source code. For citation scanning the pass MUST hit source files (`src/`, `packages/`, `harness/`, etc.) — these are exactly where citation comments live.

The right pattern: copy/extract `walkSourceTree` from `gc/stub-hits.ts`. That function already handles SKIP_DIRS (`.git`, `node_modules`, `.archive`, `dist`, etc.). Either:
- Refactor `walkSourceTree` to be exported from a new shared module (e.g. `gc/walk-source.ts`) and have both `stub-hits.ts` and the new `citation-integrity.ts` import it; OR
- Duplicate the walker into `citation-integrity.ts`.
The shared-module approach is preferred but the duplication is fine if it keeps the diff smaller. Note: Task 9 (`gc/scope-coverage.ts`) ALSO uses this walker, so the shared-module extraction is more valuable — do that.

**Goal:** Add a seventh GC pass — `citation-integrity` — that walks all source files, scans for `§V<N>` and `TODO(TSK-)` citations and `DEC-\d+` policy violations, and verifies each ID resolves cleanly in the appropriate ledger.

**Files to modify:**
- `packages/harness-core/src/gc/types.ts`
  - Add `"citation-integrity"` to the `GcPassId` union.
  - Add `"orphaned_citation"`, `"superseded_citation"`, and `"banned_dec_comment"` to the `GcFindingKind` union.
- `packages/harness-core/src/gc/sweep.ts`
  - Import `runCitationIntegrity` from `./citation-integrity.js`.
  - Add `"citation-integrity": 0` to `passDurations`.
  - Add a seventh pass block after pass 6.

**File to create:** `packages/harness-core/src/gc/citation-integrity.ts` — exports `function runCitationIntegrity(opts: { repoRoot: string; maxFileBytes?: number }): { findings: GcFinding[] }`. Logic:
1. Walk source files via `walkSourceTree` (now exported from `gc/walk-source.ts` per the shared-module refactor above).
2. Restrict to text-likely extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.swift`, `.kt`, `.sh`, `.sql`, `.html`, `.vue`, `.svelte`, `.css`, `.scss`).
3. Skip files > `maxFileBytes` (default 256KB).
4. For each file: read content, run `scanCitations` from `hooks/post-tool-use/citation-scanner.ts`.
5. Load the invariants ledger via `buildInvariantsLedger` (already in `ground/ledgers.ts`) once before the loop.
6. For each `§V<N>` match:
   - If invariant id not in ledger → emit `kind: "orphaned_citation"`, `severity: "warn"`.
   - If invariant has `superseded_by` → emit `kind: "superseded_citation"`, `severity: "warn"`, detail mentions the supersedes id.
7. For each `DEC-<N>` match → emit `kind: "banned_dec_comment"`, `severity: "warn"`, detail says "DEC-id inline comments are banned per PRIMER §10."
8. (Optional, low priority) For each `TODO(TSK-<id>)`: look up in `tasks/active/`/`tasks/done/`. If not found → finding `"orphaned_citation"` with detail mentioning the TODO. (Skipped TODOs found in done tasks are noisy — leave those for now.)

**Skip these directories** in addition to the `SKIP_DIRS` already in `walkSourceTree`: `.harness/` (no citations expected) and `.archive/` (already in SKIP_DIRS).

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- Empty repo (or repo with no source files) returns empty findings.
- A test fixture with a known orphan `§V9999` citation in a `.ts` file produces exactly one `orphaned_citation` finding.

---

### TASK 12 — MCP tool: harness_append_run_note + path-allowlist update

**READ FIRST:**
- `docs/CONTEXT_CONTINUITY_SPEC.md` §2.3 (agent notes)
- `packages/harness-core/src/mcp/tools/append.ts` (the SIMPLER append-only pattern — closer to what this task needs than `record-decision.ts`)
- `packages/harness-core/src/mcp/path-allowlist.ts` (FULL FILE — extend `APPEND_ALLOWLIST`)
- `packages/harness-core/src/mcp/schemas.ts` (FULL FILE — add a new zod input schema)
- `packages/harness-core/src/mcp/tools/index.ts` (post Task 1 — to register the new tool)

**Context to paste:** Full content of all five files. The §2.3 spec section.

**IMPORTANT — extend the path-allowlist.** The existing append-only write infrastructure (`isAppendAllowed` in `path-allowlist.ts`) gates writes to a small set of paths. `tasks/active/<id>/notes.md` is NOT currently in the allowlist; without an extension, the new tool is rejected at runtime. This task MUST update the allowlist.

**Files to create:**
- `packages/harness-core/src/mcp/tools/append-run-note.ts` — `harness_append_run_note` tool.
  - Input schema (`appendRunNoteInput` in `schemas.ts`): `{ run_id: string, phase: string, note: string }` (all `z.string().min(1)`).
  - Handler:
    1. Validate `run_id` shape (no slashes, no `..`, length ≤ 80, matches `/^[A-Za-z0-9_-]+$/`).
    2. Resolve target path: `<repoRoot>/.harness/tasks/active/<run_id>/notes.md`.
       - **Note:** the input field is named `run_id` per the spec, but the actual path uses task id. Trust the agent's input — it's the agent's responsibility to pass the id that matches the active task. Document this in the tool description.
    3. Verify the parent dir (`tasks/active/<run_id>/`) EXISTS — if not, return `mcpError("RUN_NOT_FOUND", ...)`. Do NOT create the dir; the orchestrator owns task-dir lifecycle.
    4. Append a structured line: `\n## ${new Date().toISOString()} [${phase}]\n${note}\n` to `notes.md` (creates if absent, appends otherwise).
    5. Return `{ ok: true, path: ".harness/tasks/active/<run_id>/notes.md", bytes_written: <N> }`.

**Files to modify:**
- `packages/harness-core/src/mcp/schemas.ts` — add a new export:
  ```ts
  export const appendRunNoteInput = {
    run_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, "run_id must be path-safe"),
    phase: z.string().min(1).max(80),
    note: z.string().min(1),
  };
  ```
- `packages/harness-core/src/mcp/path-allowlist.ts` — add `".harness/tasks/active/*/notes.md"` to `APPEND_ALLOWLIST`. Update the JSDoc comment block to mention the new path.
- `packages/harness-core/src/mcp/tools/index.ts` — import `appendRunNoteTool` and add to `allTools` (after `recordDecisionTool`).

**Acceptance criteria:**
- `cd packages/harness-core && npx tsc --noEmit` passes.
- `allTools` array has 15 entries (14 from Task 1 + 1 new).
- `isAppendAllowed(".harness/tasks/active/TSK-001/notes.md")` returns `true` (verified in Task 13 smoke).

---

### TASK 13 — Smoke tests for new modules

**READ FIRST:**
- `harness/scripts/smoke-session-start.ts` (existing smoke — pattern to follow, especially `mkFixture` + cleanup approach)
- `harness/package.json` scripts block

**Context to paste:** Full content of smoke-session-start.ts + harness/package.json scripts block.

**Files to create:**
- `harness/scripts/smoke-read-enrich.ts` — imports `runReadEnricher`-like internals from `@devplusllc/harness-core`. Constructs a minimal PostToolUse stdin payload with a fake file path and content containing `// §V0001` and `// TODO(TSK-foo)`. Runs the in-process scanner + legend builder against an empty/minimal ledger fixture. Asserts:
  - Output legend block is non-null when citations exist.
  - Empty content produces null legend (no enrichment, no errors).
  - Files > 512KB are passed through unmodified (synthetic large content).
  - When the fixture includes a `scope-index.yaml` with an entry for the file, the legend includes "Decisions in scope" / "Invariants in scope" lines.
  Exit 0 on success.
- `harness/scripts/smoke-status-line.ts` — imports `readStatusForCLI` and `writeStatusJson` from `@devplusllc/harness-core`. Creates a temp dir, writes a synthetic state JSON via `writeStatusJson`, then calls `readStatusForCLI(tempDir)` and asserts the formatted output starts with `⬡ harness`. Then calls `readStatusForCLI("/no/such/dir")` and asserts the placeholder string `daemon:down` substring is present. Exit 0 on success.
- `harness/scripts/smoke-handoff.ts` — imports `buildHandoffBlock` and `buildSpecDelta`. Creates a temp dir with `.harness/` but no `tasks/active/`. Asserts `await buildHandoffBlock(tempDir)` returns `null`. Asserts `await buildSpecDelta(tempDir, [])` returns `null`. Asserts `await buildSpecDelta(tempDir, ["src/foo.ts"])` returns `null` (no git history for that path). Exit 0 on success.
- `harness/scripts/smoke-scope-index.ts` — imports `readScopeIndex`, `writeScopeIndex`, `lookupScope` from `@devplusllc/harness-core`. Creates a temp dir, writes a sample scope-index, reads it back, asserts `lookupScope(idx, "src/auth/login.ts")` returns the expected entry, asserts a path with no entry returns `null`. Exit 0 on success.

**Files to modify:**
- `harness/package.json` — add four new scripts:
  ```json
  "smoke:read-enrich": "tsx scripts/smoke-read-enrich.ts",
  "smoke:status-line": "tsx scripts/smoke-status-line.ts",
  "smoke:handoff": "tsx scripts/smoke-handoff.ts",
  "smoke:scope-index": "tsx scripts/smoke-scope-index.ts"
  ```

**Note:** The Task 4b SessionStart brand+positioning addition is exercised by extending `smoke-session-start.ts` minimally (per Task 4b acceptance criteria) — no new smoke file needed for it.

**Acceptance criteria:**
- All four new smoke scripts execute without throwing.
- `pnpm smoke:read-enrich`, `pnpm smoke:status-line`, `pnpm smoke:handoff`, `pnpm smoke:scope-index` all exit 0.
- The existing `pnpm smoke:session-start` still exits 0.

---

## FINAL VERIFICATION

After all 14 tasks (1, 2, 3, 4, 4b, 5, 6, 7, 8, 9, 10, 11, 12, 13) are committed, run:

```bash
# Full compile
cd packages/harness-core && npx tsc --noEmit
cd harness && npx tsc --noEmit

# Smoke tests
cd harness && pnpm smoke:session-start
cd harness && pnpm smoke:read-enrich
cd harness && pnpm smoke:status-line
cd harness && pnpm smoke:handoff
cd harness && pnpm smoke:scope-index
cd harness && pnpm smoke:gc
```

Write `harness-build/BUILD_REPORT.md` with:
- Each task: DONE / PARTIAL / FAILED
- Final compile status for each package
- Smoke test results
- Any known gaps or issues for human review
- Git log of all commits made during this session

---

## RECOVERY PROTOCOL

If you cannot continue (context limit, error cascade):
1. Commit whatever is in a clean compile state
2. Write `harness-build/RESUME.md`:
   ```
   Last completed task: <number, e.g. 4b or 9>
   Git HEAD: <sha>
   Next task: <number>
   Known context: <anything the next instance needs to know>
   Partial work: <describe any in-flight changes not yet committed>
   ```
3. The next instance pastes this file and skips completed tasks

---

## START NOW

Begin with Task 1. Read `packages/harness-core/src/mcp/tools/index.ts`, `packages/harness-core/src/session-start/templates.ts`, and `docs/MCP_SURFACE.md`, then dispatch the Task subagent with a fully self-contained brief that includes the TYPESCRIPT CONSTRAINTS block. Work through all 14 tasks in order. Commit after each passing compile gate. You have the full context of this monorepo available to you — use it.
