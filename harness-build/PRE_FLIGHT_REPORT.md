# Pre-Flight Report — 2026-05-04

## Summary
- Audits run: A through J
- Issues found: 17 (5 critical, 8 important, 4 minor)
- Issues corrected: 17 (all in MASTER_PROMPT.md / AUDIT.md / template files)
- Tasks marked SKIP: 0
- New tasks added: 1 (Task 4b — SessionStart brand + positioning injection)
- Spec docs corrected: 0 (operator declined cross-reference cleanup; PRIMER.md §12 + AGENTS.md links to deleted docs left as-is)
- Improvement proposals: 15 generated, 14 approved, 14 applied (operator skipped #10 — AGENTS.md / PRIMER.md cross-ref cleanup)

---

## Findings

### Critical (would have caused build failure)

1. **Task 7 — settings.json mechanism wrong.** The brief told the subagent to "search init.ts for where settings.json is written," but `init.ts` never writes it. The file is shipped at `packages/harness-core/templates/.claude/settings.json` and copied verbatim by `seedHarnessLayout`. Verified by `grep -rn "settings\.json\|settingsJson\|PostToolUse\|SessionStart" packages/harness-core/src/init/` returning zero matches. The subagent would have either burned its context hunting for nonexistent code or invented something that doesn't match the seed pipeline.
   **Correction:** Rewrote Task 7 to edit the template file directly, with the full new template content (including `npx -y @devplusllc/harness` to match the existing SessionStart entry) inlined into the brief.

2. **Task 9 — attestation.yaml shape was fictional.** Brief told the subagent to read `tasks/done/<id>/attestation.yaml` and check a `git_sha` field. Per FILESYSTEM_LAYOUT.md §7.1 + §7.3: `attestation.yaml` lives in `runs/active/<run_id>/`, carries no `git_sha` field (the pin is `meta.json.sha_pin`), and sensor pass/fail lives in `sensor-results.yaml` (separate file). Subagent would have written a pass that reads non-existent files/fields, returning silent zero findings.
   **Correction:** Rewrote Task 9 with the actual file layout (linkage via `tasks/done/<id>/status.yaml.related_run_ids` → `runs/<active|terminal>/<run_id>/{meta.json, attestation.yaml, sensor-results.yaml}`) and the actual SHA field name (`meta.sha_pin`).

3. **Task 10 — wrong walker.** Brief said "use `walkCanonical` or similar git-tracked walk," but `walkCanonical` (in `ground/walk.ts`) excludes source code — citation comments live in `src/`, `packages/`, `harness/`, all outside the canonical zone. Result: silent zero-citation finding ("no debt detected" — wrong).
   **Correction:** Rewrote Task 10 to use `walkSourceTree` from `gc/stub-hits.ts` (suggested either shared-module extraction or duplication) and pasted that function's contract into the brief.

4. **Task 4 — "never-drop set" doesn't exist.** Brief said add `run_handoff` to "the never-drop set alongside decisions/invariants ledgers." The current `buildSessionStartContext` uses a single `dropPriority` array; nothing is "never-drop" except by being last in the array. Subagent would have searched for code that doesn't exist.
   **Correction:** Rewrote Task 4 to direct the subagent to add `run_handoff` to the END of `dropPriority` (drop-last) and to the START of `orderedSections` (render-first). Also flagged the breaking signature change (`buildSessionStartContext` becomes `async`) and listed all caller sites that must be updated.

5. **Task 1 — acceptance count off-by-one.** Brief said `allTools` should have 15 entries after removing 4. Reality: `allTools` currently has 18; 18 − 4 = 14. The "15" only holds after Task 11 adds `harness_append_run_note`. The compile gate would have rejected Task 1 incorrectly.
   **Correction:** Updated Task 1 acceptance to "14 entries; will become 15 after Task 11."

### Important (would have caused incorrect implementation)

6. **session-start `templates.ts` still cited banned tools.** `TOOL_QUICK_REFERENCE` in `packages/harness-core/src/session-start/templates.ts` listed `harness_record_run_event`, `harness_drop_task`, and `harness_ask_operator`. Even after Task 1 removed them from `allTools`, every fresh Claude Code session would still be advertised these dead tools.
   **Correction:** Folded the templates.ts cleanup into Task 1 as Step 2 of that task.

7. **No always-inject of brand / positioning at SessionStart.** PRIMER §3 and DOCS_SPEC §5.5 mandate `brand/overview.md` and `product/positioning.md` at every SessionStart. `buildSessionStartContext` reads neither, and Task 8 only seeds the stubs. The whole point of brand-as-ground-state — preventing generic AI design output — was unaddressed.
   **Correction:** Added Task 4b that wires the injection. Render position is between `header`/`two_zone_reminder` and the rest of the content; drop priority places it between `pending_drafts` and `invariants_active`. Adds a `[DRAFT]` marker in the legend when `status: draft` so the agent knows to ask before deciding.

8. **`harness_append_run_note` ignored path-allowlist.** Task 11 added the tool but did not extend `mcp/path-allowlist.ts`. The existing `appendTool` (Task 1 removes from public surface but path infrastructure remains) gates writes via `isAppendAllowed`; the new tool would have been rejected at runtime with `PATH_NOT_ALLOWED`.
   **Correction:** Added explicit path-allowlist update bullet to Task 11 (`.harness/tasks/active/*/notes.md`). Also pointed the brief at `append.ts` (simpler pattern) instead of `record-decision.ts` (heavyweight) as the reference.

9. **Task 8 used divergent stub-creation path.** Brief told the subagent to write brand/product/capabilities stubs programmatically inside `seed.ts` with `existsSync` checks. Every other seeded file lives in `templates/` and is copied by `seedHarnessLayout`. Two paths means future maintenance forgets one or the other.
   **Correction:** Rewrote Task 8 to add stub files under `templates/.harness/ground/{brand,product,capabilities}/`. `seedHarnessLayout`'s existing collide-fail behavior protects existing operator content. No `seed.ts` code changes.

10. **`packages/harness-core/src/index.ts` re-exports for new modules missing.** Tasks 2, 3, 5, 6 add `status-line/`, `context/`, `hooks/post-tool-use/` directories. The existing `src/index.ts` re-exports every other subdir but no task updated it. Smokes (Task 12) and `harness/src/cli/*` would not be able to import the new modules.
   **Correction:** Added "add `export * from './<dir>/index.js'` to `packages/harness-core/src/index.ts`" as an acceptance bullet on Tasks 2, 3, 5, and 6.

11. **CLI help text missing new subcommands.** `harness/src/cli/index.ts` `usage()` block didn't list `status-line` and only mentioned `session-start` for `hook`. Tasks 2, 5, 6 added subcommands but no task updated the help.
   **Correction:** Added "update usage()" bullets to Tasks 2 and 5. The Task 6 brief reuses Task 5's wired `usage()` since it adds a sibling subcommand.

12. **sensors.yaml template missing `copy_safety` block.** Task 6 referenced `copy_safety_globs` and `copy_safety_allowlist` keys that don't exist in `templates/.harness/config/sensors.yaml`. The write guardian would have always fallen through to hardcoded defaults; the operator-customizable globs spec would be unreachable.
   **Correction:** Folded sensors.yaml extension into Task 6 with the literal YAML block to append.

13. **TypeScript strict-mode constraints not surfaced.** None of the 12 task briefs warned the subagents about `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `strict`, or `NodeNext` import-extension rules. Subagents writing idiomatic TS would have hit ~3 retries each.
   **Correction:** Added a top-level "TYPESCRIPT CONSTRAINTS" block immediately after GROUND RULES, with one fix idiom and one example each. Briefing instruction in Ground Rule 2 now mandates pasting this block into every subagent prompt.

### Minor (doc cleanup, cross-references)

14. **Task 5 PostToolUse payload-shape uncertainty.** READ_ENRICHER_SPEC.md described the input as `{ tool_name, tool_input: { file_path }, tool_response: { content } }`. Claude Code's actual PostToolUse payload includes additional standard fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`); the Read-tool `tool_response` may be a structured object whose content is line-number-prefixed (`cat -n` style). If the assumption was wrong, citation legends would render against malformed text.
    **Correction:** Added a payload-shape verification block at the top of Task 5: define a permissive `ClaudePostToolUsePayload` type with optional standard fields; treat `tool_response` as a record with `content | text | output` candidates; strip line-number prefixes when computing line numbers; passthrough on any unrecognized shape.

15. **Task 5 hook output field — `modified_tool_response` is not a documented Claude Code contract field.** The spec implies the PostToolUse hook can rewrite the tool result via `hookSpecificOutput.modified_tool_response.content`. That field is not part of Claude Code's documented hook output. The documented field is `additionalContext`, which prepends content to the agent's view (functionally equivalent for the legend use case).
    **Correction:** Updated Task 5 to use `additionalContext` per Claude Code's documented contract. Added an explicit note to NOT emit `modified_tool_response`. The user-facing behavior (legend visible to the agent before/with code) is identical.

16. **Task 5 — DEC-id scanner role unclear.** The legend builder must show DEC-ids as policy violations, but the citation scanner shouldn't enrich them as live citations. Brief was ambiguous.
    **Correction:** Clarified Task 5: `scanCitations` returns three arrays (`invariants`, `todos`, `decIds`); the `decIds` array exists ONLY for the policy-violation legend, never enriched as a normal citation.

17. **Task 2 — `--project-root` flag missing.** STATUS_LINE_SPEC §2 states `harness status-line --project-root /path/to/project`. The brief said `readStatusForCLI(cwd)` only, missing the flag.
    **Correction:** Added `--project-root <path>` argument parsing to the Task 2 CLI brief, defaulting to `process.cwd()`.

### Approved improvement proposals applied

1. ✅ **#1 — Task 7 settings.json mechanism wrong** — Critical finding above.
2. ✅ **#2 — Task 9 attestation.yaml fields don't exist** — Critical finding above.
3. ✅ **#3 — Task 10 wrong walker** — Critical finding above.
4. ✅ **#4 — Task 4 never-drop set mischaracterization** — Critical finding above.
5. ✅ **#5 — Task 1 off-by-one** — Critical finding above.
6. ✅ **#6 — templates.ts banned tools cleanup** — Important finding above (folded into Task 1).
7. ✅ **#7 — SessionStart brand/positioning injection** — New Task 4b added.
8. ✅ **#8 — append-run-note path-allowlist update** — Important finding above (added to Task 11).
9. ✅ **#9 — CLI help text for new subcommands** — Important finding above (bullets added).
10. ⏭️ **#10 — AGENTS.md / PRIMER.md cross-ref cleanup** — Skipped per operator vote.
11. ✅ **#11 — sensors.yaml `copy_safety` block** — Important finding above (folded into Task 6).
12. ✅ **#12 — Task 8 template approach** — Important finding above (Task 8 rewritten).
13. ✅ **#13 — `index.ts` re-exports** — Important finding above (bullets on Tasks 2/3/5/6).
14. ✅ **#14 — TypeScript strict constraints surfaced** — Important finding above (top-level block added).
15. ✅ **#15 — PostToolUse payload shape verification** — Minor finding above (verification block in Task 5).

### Skipped improvement proposals

- #10 — AGENTS.md + PRIMER.md §12 reference deleted docs (operator declined).

---

## Confidence assessment

**High confidence:** Tasks 1, 2, 7, 8, 11, 12 — the corrections are mechanical, file paths and APIs are verified against actual source, and the briefs are now self-contained.

**Medium-high confidence:** Tasks 3, 4, 4b, 6, 9, 10 — corrections address concrete spec/code mismatches; remaining risk is in the breadth of Task 4's signature change (sync→async) ricocheting into callers I may not have enumerated. The brief instructs a `grep` for all call sites; if a caller I missed exists, the compile gate catches it.

**Medium confidence:** Task 5 — the PostToolUse payload shape is the largest remaining uncertainty. I added a graceful-passthrough fallback so a wrong assumption produces a no-op rather than a crash, but the *enrichment* may not actually fire as intended on first integration test. This is acceptable: the legend is a token-saving optimization, not a correctness gate. If the shape is wrong, citations resolve via the existing `harness_invariant_get` MCP tool path the agent always has.

**Remaining unknowns:**
- The exact field names Claude Code uses in PostToolUse `tool_response` for the `Read` tool. This needs a smoke test against a real session to lock down — recommend doing this before the read-enricher is registered in template settings.json for production projects.
- Whether Claude Code's PostToolUse hook contract allows `additionalContext` injection (it documents `additionalContext` for SessionStart and PreCompact; PostToolUse documentation is sparser). Same fallback applies — graceful pass-through if the hook output is rejected.
- The `simple-git` `revparse` / `catFile` / `log` API surface used in Tasks 3 + 9 is consistent with existing usage in `gc/sweep.ts` and `gc/apply.ts`, so this is low risk.

**Compile-gate risk:** The Task 4 sync→async signature change is the highest single-task risk for cascading compile errors. The brief explicitly enumerates all known caller sites (the SessionStart hook, the smoke). If any other internal caller exists (e.g. inside `harness-runtime`), the compile gate flags it on retry.

---

## Recommended first action for Opus

1. Read `harness-build/MASTER_PROMPT.md` end-to-end, including the new TYPESCRIPT CONSTRAINTS block.
2. Before dispatching Task 1: do a quick `git log` of the last 5 commits and a `git status` to confirm starting state matches the assumption ("compiles clean today").
3. Dispatch Task 1 with the standard self-contained brief plus the TYPESCRIPT CONSTRAINTS block. Verify the compile gate passes BEFORE committing — Task 1 is the lowest-risk task and a clean pass confirms the brief format is working before higher-risk tasks (3, 4, 5, 9, 10) are dispatched.
4. After Task 11 is done, before Task 12: run `node -e "import('@devplusllc/harness-core').then(m => console.log(Object.keys(m).sort()))"` (or equivalent) to confirm the public barrel is wired correctly. Task 12 smokes depend on this.

If the run is interrupted mid-build, the recovery protocol (RESUME.md) is unchanged; the new Task 4b numbering convention ("Task 4b") is parseable as a discrete checkpoint.
