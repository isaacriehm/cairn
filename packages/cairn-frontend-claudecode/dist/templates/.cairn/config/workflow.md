---
type: workflow-policy
status: draft
audience: dual
generated: 2026-05-02T13:19:00Z
verified-at: 2026-05-02T13:19:00Z
source-commits:
  - manual

# ──────────────────────────────────────────────────────────────────────────────
# Project-extension placeholder.
#
# At adoption, the init script REPLACES this block with a real key matching
# the adopting project's `package.json name` (or directory name, lowercased,
# with non-alphanumerics → underscores).
#
# Cairn package code reads this block by `Object.keys()` lookup — never by
# hardcoded project name.
# ──────────────────────────────────────────────────────────────────────────────

<project_name>:
  off_limits:
    - .git/**
    - .archive/**
    - .env
    - .env.local
    - node_modules/**
    # adopting project extends with its own off-limits paths at init
  high_stakes_globs: []                 # populated at init from stack-profile heuristic + operator confirm
  trust_posture:
    safe_class_auto_merge: true
    code_class_auto_merge: false
    high_stakes_auto_merge: false

---

# Workflow policy

This file is the on-disk surface for the **project-extension block** that
`cairn-core/src/sensors/runner.ts` reads (via `Object.keys()` lookup) and
that the Phase-3 init mapper patches with discovered globs and sensors.

The plugin-era cairn does NOT use this file as a per-task prompt template
— each task's spec lives at `.cairn/tasks/active/<task_id>/spec.tightened.md`
and is written directly by the `cairn-direction` skill. The reviewer
subagent reads that spec; nothing renders this markdown body.

If you're looking for the daily flow, see `docs/SYSTEM_OVERVIEW.md` §4.

# Component reuse discipline

**Iron rule: before building any UI component, load the in-scope component
inventory and check it first.** The same drift Cairn prevents for decisions
applies to components — an agent that rebuilds a component that already
exists ships a duplicate, then misuses the refactor. `cairn-direction`
injects the in-scope inventory into every UI task; read it in full.

The ladder, in strict order — **USE > EXTEND > CREATE**:

1. **USE** — an indexed component fits. Read its header via
   `cairn_component_get({name})` for `@props`/`@example`, then import it.
   Never reimplement what already exists.
2. **EXTEND** — a component almost fits. Add a prop or variant **in place**
   and reuse it. Do not fork or copy.
3. **CREATE** — nothing fits. The new component file MUST carry a complete
   `@cairn` header (grammar below) before the task closes, or the
   component check blocks the commit.

## `@cairn` header grammar

Every component file carries a structured header comment — the header **is**
its registry entry, living with the code so it can't drift elsewhere. Block
form (the first `/** */` comment) or hash form (the first contiguous `#`
run) are both accepted.

Required tags:

- `@cairn <ExportName>` — the exact exported name, unique within the
  workspace. The registry must never lie about the code.
- `@category <name>` — one of the project's component categories.
- `@purpose <line>` — one searchable sentence.
- `@aliases <a, b, …>` — at least two comma-separated nouns a teammate
  might search for.

Optional: `@props`, `@uses`, `@status` (`stable|wip|deprecated`),
`@example`, and `@singleton` (valueless).

Example:

```tsx
/**
 * @cairn PrimaryButton
 * @category forms
 * @purpose The app's main call-to-action button with loading + disabled states.
 * @aliases cta button, submit button, action button
 * @props variant, size, loading, disabled
 */
```

## Singletons

A header tagged `@singleton` declares a component that exists **exactly
once** by project decision — the app shell, the global nav, the root
provider. Adoption promotes each `@singleton` to a hard invariant
("`<Name>` exists exactly once"). Extend it in place; never fork, copy, or
rebuild it. The component check's duplicate-name gate enforces uniqueness.
