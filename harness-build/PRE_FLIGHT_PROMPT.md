# Harness Pre-Flight Audit Prompt

**Run this BEFORE `MASTER_PROMPT.md`. It audits the spec docs and build plan against the actual codebase and corrects everything it finds wrong. No production code is written during this prompt — only the build plan and docs are modified.**

---

## WHAT YOU ARE

You are a build-plan auditor for the Harness project. Harness is a TypeScript pnpm monorepo that acts as a project brain for Claude Code — ground state management, MCP tools, Claude Code hooks (SessionStart, PostToolUse), GC passes, and a CLI.

The build plan in `harness-build/MASTER_PROMPT.md` was written by a Sonnet model that went through two context compactions. It describes 12 tasks to close gaps between the current codebase and the updated spec. **Your job is to find every error in that plan before Opus executes it overnight.**

You will not write production code. You will:
1. Read every spec doc and build plan file
2. Read every source file referenced in the 12 tasks  
3. Cross-check for inconsistencies, wrong paths, wrong APIs, missing context, wrong assumptions
4. Correct `harness-build/MASTER_PROMPT.md` in-place
5. Fix any spec doc cross-references that are broken
6. Write `harness-build/PRE_FLIGHT_REPORT.md` documenting everything found

---

## STEP 1 — Read all inputs

Read every file in this list before forming any conclusions. Do not start writing corrections until you have read them all.

**Spec docs:**
```
docs/PRIMER.md
docs/DOCS_SPEC.md
docs/ARCHITECTURE.md
docs/MCP_SURFACE.md
docs/FILESYSTEM_LAYOUT.md
docs/SESSIONSTART_SPEC.md
docs/READ_ENRICHER_SPEC.md
docs/CONTEXT_CONTINUITY_SPEC.md
docs/STATUS_LINE_SPEC.md
docs/DAEMON_SPEC.md
docs/INIT_SPEC.md
docs/UAT_PIPELINE.md
```

**Build plan:**
```
harness-build/MASTER_PROMPT.md
harness-build/AUDIT.md
```

**Existing source files the tasks will touch — read every one:**
```
packages/harness-core/src/mcp/tools/index.ts
packages/harness-core/src/mcp/tools/record-decision.ts   (Task 11 pattern)
packages/harness-core/src/session-start/build.ts
packages/harness-core/src/session-start/templates.ts
packages/harness-core/src/gc/types.ts
packages/harness-core/src/gc/sweep.ts
packages/harness-core/src/gc/stub-hits.ts                (pattern for new passes)
packages/harness-core/src/init/init.ts
packages/harness-core/src/init/seed.ts
packages/harness-core/src/ground/ledgers.ts
packages/harness-core/src/ground/paths.ts
packages/harness-core/src/ground/index.ts
packages/harness-core/src/index.ts                       (public exports)
harness/src/cli/index.ts
harness/src/cli/hook.ts
harness/package.json
packages/harness-core/package.json
packages/harness-core/tsconfig.json
harness/tsconfig.json
```

**Also run these shell commands to understand the actual repo state:**
```bash
# What does the existing templates directory contain?
find packages/harness-core/templates -type f | sort

# What does .claude/settings.json look like when harness init runs?
# (look for the settings.json template or where it's written in init.ts)
grep -rn "settings\.json\|settingsJson\|PostToolUse\|SessionStart" packages/harness-core/src/init/ | grep -v "\.js:"

# What TypeScript version features are available?
cat packages/harness-core/tsconfig.json

# Does harness-core export anything from ground/ledgers that the handoff builder needs?
grep -n "export" packages/harness-core/src/ground/ledgers.ts

# What does the simple-git API look like in use in this project already?
grep -rn "simpleGit\|simple-git\|SimpleGit" packages/ harness/ --include="*.ts" | grep -v node_modules | grep -v dist | head -20

# What existing tests/smokes verify the session-start hook?
cat harness/scripts/smoke-session-start.ts

# Are there any existing PostToolUse references anywhere?
grep -rn "PostToolUse\|post-tool-use\|read-enrich\|write-guard" packages/ harness/ --include="*.ts" | grep -v node_modules | grep -v dist

# What does the Claude Code PostToolUse hook payload actually look like?
# Check if there's any documentation or comment in hook.ts about the shape
grep -A 10 "PostToolUse\|stdin\|payload\|hook_event" harness/src/cli/hook.ts | head -40

# Full structure of init.ts (it's large - check where .claude/settings.json is written)
grep -n "settings\|\.claude\|hooks\|hook_event\|SessionStart" packages/harness-core/src/init/init.ts | head -40
```

---

## STEP 1.5 — Generate improvement proposals and WAIT for operator vote

**Do this immediately after completing all reads in Step 1. Do not run any audits yet.**

You have now read the full spec, the build plan, and the actual codebase. Before doing any corrections, surface your 15 best ideas for improvements — things you noticed while reading that aren't strict errors but would make the system meaningfully better, clearer, or more robust.

These can be:
- Spec gaps or underspecified edge cases that a future author would misread
- Design choices that seem inconsistent across docs
- Missing error handling or failure mode coverage
- Places where a task brief is technically correct but would benefit from tighter guidance
- Anything in the design itself that strikes you as worth reconsidering before the build locks it in

**Format your proposals exactly like this:**

```
## 15 Improvement Proposals

1. [CATEGORY] Short title
   What: one sentence describing the gap or issue
   Why it matters: one sentence on the consequence if left as-is
   Proposed fix: one sentence on what you'd add/change

2. [CATEGORY] ...
...
```

Categories to use: `[SPEC GAP]`, `[CONSISTENCY]`, `[EDGE CASE]`, `[BRIEF QUALITY]`, `[DESIGN]`

After listing all 15, write this exact line and then stop:

```
---
Vote on these by replying with the numbers you approve (e.g. "1, 3, 7, 12") or "all" or "none".
I will incorporate approved items into my corrections before touching any files.
```

**HARD STOP — do not proceed to Step 2 until the operator replies with their vote.**

When the operator replies:
- Mark each approved item as `[APPROVED]` in your internal plan
- Mark each skipped item as `[SKIPPED]`
- Then continue to Step 2 immediately, incorporating approved items as additional correction targets alongside the audit findings

---

## STEP 2 — Run these specific audits

Work through each check. For each finding, note: file, line, what's wrong, what the fix is.

### Audit A — File paths and imports in MASTER_PROMPT.md

For every file path mentioned in each task brief:
- Does the file actually exist at that path?
- For files being CREATED: does the parent directory exist or need to be created?
- For `import` statements the subagent will need to write: do the source modules export what's needed?

Specifically verify:
- Task 3 says to use `simple-git` — is it a dep of `harness-core` specifically? (Not just `harness`.)
- Task 4 says to import from `../context/handoff-builder.js` — does this resolve correctly given the tsconfig module settings?
- Task 5 says to import ledger readers from `ground/ledgers` — what are the exact exported function names?
- Task 9 says to use `simple-git` to check git log — what is the exact API call pattern used elsewhere in the project?

### Audit B — Where does init.ts write .claude/settings.json?

This is the highest-risk task brief (Task 7). The pre-flight author could not find the settings.json write via grep. Find it:
- Search `packages/harness-core/src/init/init.ts` for any `writeFileSync` or `writeFile` calls
- Search for `settings` (case insensitive) in `init/`
- Check if it uses a template file from `packages/harness-core/templates/`
- Check `packages/harness-core/templates/` for a `.claude/settings.json` template

Once found: correct Task 7 in MASTER_PROMPT.md with the actual mechanism (template vs. code write) and exact location.

### Audit C — Claude Code PostToolUse hook payload shape

Task 5 and 6 describe the stdin JSON shape for PostToolUse hooks as:
```json
{ "tool_name": "Read", "tool_input": { "file_path": "..." }, "tool_response": { "content": "..." } }
```

Verify this is correct by:
- Checking the existing `harness/src/cli/hook.ts` for how it reads the SessionStart payload — the PostToolUse payload will follow the same Claude Code hook contract
- If the Claude Code hook documentation is referenced anywhere in the codebase (comments, README), read it

If the shape is different from what's described in the task briefs, correct Tasks 5 and 6.

### Audit D — TypeScript compilation constraints

Read `packages/harness-core/tsconfig.json` and `harness/tsconfig.json`. Verify:
- Module resolution mode (NodeNext? Bundler?) — affects how `.js` extension imports work
- `strict: true` — affects what patterns subagents must follow
- `target` and `lib` — affects what APIs are available
- Any path aliases that subagents should use

Add a "TypeScript constraints" note to MASTER_PROMPT.md if any of these would affect how subagents write code.

### Audit E — GcPassId and existing pass integration

Task 9 says to add `"completion-integrity"` to `GcPassId` and integrate into `runGcSweep`. Read `gc/sweep.ts` and `gc/types.ts` fully to verify:
- The exact shape of `RunGcSweepOptions` — does it already have per-pass options that need extending?
- How existing passes are called in `runGcSweep` — what does integration actually look like?
- Does `GcFindingKind` need updating for new finding types or is it extensible?

Correct Tasks 9 and 10 with the exact integration pattern from the live code.

### Audit F — session-start/build.ts Section 0 integration

Task 4 describes prepending a handoff block as the first section. Read `build.ts` fully and verify:
- How sections are currently ordered and truncated — is there a `never-drop` set that needs updating?
- What `source` handling, if any, already exists
- Whether `SessionStartSection` is a const-enum, string union, or something else that affects how `"run_handoff"` should be added
- Whether there are any tests for `buildSessionStartContext` that would break

### Audit G — Spec doc cross-references

Check every file in `docs/` for broken references:
- Links to `QUESTIONS.md` (archived — should be removed)
- Links to `WORKFLOW_GUIDE.md` (archived)
- Links to `INTEGRATION_PLAN.md` (archived)
- SESSIONSTART_SPEC.md still has the old 3 banned tools in the tool quick-reference section — verify whether Task 4 correctly updates this or if a separate spec fix is needed
- PRIMER.md §8.5 hook table — does it match the current spec accurately?
- Any `§N` section references in one doc that point to the wrong section in another

### Audit H — What's missing from the 12-task plan

Check the spec docs against the AUDIT.md task list for anything the plan missed. Specifically look for:

- Does the `harness` CLI's `index.ts` need updating for the `status-line` subcommand? (Task 2 mentions it but verify it's specific enough)
- Does `session-start/templates.ts` need updating (tool quick-reference section that currently lists banned tools)?
- Does the public `packages/harness-core/src/index.ts` need to re-export any new modules (status-line, context, hooks)?
- Does `harness-build/AUDIT.md` correctly list all gaps or did it miss any?
- Is there anything in `docs/CONTEXT_CONTINUITY_SPEC.md` that the handoff-builder task (Task 3) missed — for example, the `harness_append_run_note` MCP tool is in Task 11, but does Task 3 need to be aware of the `notes.md` format it reads?

### Audit I — Spec vs. existing code reality

For each of these, check if the spec says one thing but the code already does something different:

- Does `session-start/build.ts` already inject brand/positioning? (If yes, Task 8's seeding is the only gap, no session-start change needed)
- Does `init.ts` already have any partial PostToolUse hook wiring?
- Does `gc/sweep.ts` already have more than 5 passes (i.e. was something already added)?
- Does `harness/src/cli/hook.ts` already have stubs for `read-enrich` or `write-guard`?

If the code already partially implements something a task is supposed to add, correct the task to only add what's missing.

### Audit J — MASTER_PROMPT.md subagent brief quality

For each of the 12 tasks, ask: "if a subagent received only this brief, would it have enough context to implement correctly without guessing?"

Red flags to look for:
- Task says "follow the pattern from X" but doesn't give the subagent the content of X
- Task references a TypeScript type that isn't defined anywhere in the brief
- Acceptance criteria that can't be mechanically verified
- Ambiguous file paths (relative vs. absolute, which package root)
- Missing error handling requirements for file operations

For each gap found: add the missing context directly into the relevant task section in MASTER_PROMPT.md.

---

## STEP 3 — Correct everything

After completing all audits:

**Corrections to make:**
1. Edit `harness-build/MASTER_PROMPT.md` directly — fix every issue found. This includes: wrong file paths, missing context, wrong API shapes, integration details, TypeScript constraints.
2. Fix any broken cross-references in `docs/` spec files (wrong section numbers, links to archived files, etc.).
3. If a task is redundant because the code already implements it, mark it `[SKIP — already implemented]` in MASTER_PROMPT.md with a note explaining why.
4. If a task is missing that the plan didn't include, add it as a new numbered task at the appropriate position in the ordered list.
5. For every improvement proposal the operator approved in Step 1.5: apply it now as part of this same pass. Treat approved proposals with the same weight as audit findings — they are corrections, not suggestions.

**Do not:**
- Write any code in `packages/` or `harness/src/`
- Delete any spec docs
- Change the design decisions in the spec (e.g. don't re-debate whether PostToolUse should be used)

---

## STEP 4 — Write the pre-flight report

Create `harness-build/PRE_FLIGHT_REPORT.md`:

```markdown
# Pre-Flight Report — <date>

## Summary
- Audits run: A through J
- Issues found: N
- Issues corrected: N
- Tasks marked SKIP: N (already implemented)
- New tasks added: N
- Spec docs corrected: N files
- Improvement proposals: N generated, N approved, N applied

## Findings

### Critical (would have caused build failure)
[list each with: what was wrong, what was corrected, where]

### Important (would have caused incorrect implementation)
[list each with: what was wrong, what was corrected, where]

### Minor (doc cleanup, cross-references)
[list each]

### Approved improvement proposals applied
[list each approved proposal with: what was changed, where]

### Skipped improvement proposals
[list each skipped proposal with its title — no explanation needed]

## Confidence assessment
[Your honest assessment: how confident are you that MASTER_PROMPT.md will
execute cleanly after these corrections? What are the remaining unknowns?]

## Recommended first action for Opus
[Any special instruction for the Opus session beyond "run MASTER_PROMPT.md"]
```

---

## STEP 5 — Final verification

Before finishing, run one more compile check to confirm nothing you edited in docs or build plan caused any issues (docs don't compile, but verify the corrections are internally consistent):

```bash
# Confirm both packages still compile clean after any changes
cd packages/harness-core && npx tsc --noEmit 2>&1
cd harness && npx tsc --noEmit 2>&1
```

If both are clean: you're done. The pre-flight is complete. Tell the user:
1. How many issues were found and corrected
2. How many improvement proposals were approved and applied
3. Where to find the pre-flight report
4. That `MASTER_PROMPT.md` is ready to paste into Opus

---

## START NOW

Begin by reading all files listed in Step 1. Read them all before drawing any conclusions. Then work through audits A-J systematically. Correct as you go.
