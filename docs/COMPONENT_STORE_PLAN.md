---
type: plan
status: complete
audience: dual
generated: 2026-06-07
purpose: Port component-reuse discipline into Cairn as a fourth ground store
---

# Component Store — Implementation Plan

> **Working plan, not locked architecture.** As each stage lands, its
> content migrates into the canonical specs
> ([`ARCHITECTURE.md`](ARCHITECTURE.md),
> [`PLUGIN_ARCHITECTURE.md`](PLUGIN_ARCHITECTURE.md),
> [`MCP_SURFACE.md`](MCP_SURFACE.md),
> [`FILESYSTEM_LAYOUT.md`](FILESYSTEM_LAYOUT.md)) and this file is retired.

---

# ⛳ RESUME HERE — COMPLETE

**S1–S8 (incl. the S6.3 annotation trio) are built and validated. The tree
is green: `pnpm build` + `pnpm smokes` both pass, `smoke-components` is in
the gate. This plan is done; its content is folded into the canonical specs
(ARCHITECTURE / PLUGIN_ARCHITECTURE / MCP_SURFACE / FILESYSTEM_LAYOUT /
README). Retain only as the historical port record.**

**Validated end-to-end:** single-app + monorepo detection
(`detectComponentsConfig`); the adoption trio `9d-comp-walk` (missing
corpus) → `9e-comp-annotate` (skill-driven, tolerant) → `9f-comp-emit`
(index build, `@singleton` → `status: active` §INV in the ledger, audit +
missing-header debt → `.cairn/baseline/components-<ISO>.yaml`); no-config
repos skip the whole trio to `10-rules-merge`; the check gate; the advisory
audit; `componentsInScope` entitlement/isolation; the pre-commit staged
narrowing; the Lens `@cairn` hover; and the Lens self-update notifier
(`update-check.ts`). One real bug was caught + fixed: `sot-emit.emitInv`
stamps `status: accepted`, but the invariants ledger only carries `active`
— so singleton INVs are written directly with `status: active`.

## What already works (done + validated end-to-end)

Manual component-store adoption is fully functional today: a repo with a
`components:` block in `.cairn/config.yaml` gets `cairn components
index|check|audit`, the two MCP tools serve the daily flow, the pre-commit +
CI gates are real, monorepo slices/isolation work, and the ingest walkers no
longer collide with `@cairn` headers.

### Files created

- `packages/cairn-state/src/components.ts` — the pure state layer: config
  load/normalize, strict `@cairn` parse (`parseComponentHeader`,
  `isComponentHeaderBlock`), `extractExportName`, `collectComponents`,
  `renderComponentsIndex` (single/manifest/slices), `validateComponents`
  (→ `ComponentFinding[]`), `buildComponentsLedger`, `componentsInScope`,
  `getComponent`. Defaults + `COMPONENT_REQUIRED_TAGS` here too.
- `packages/cairn-core/src/components/check.ts` — `runComponentCheck` →
  `SensorFinding[]` (hard: missing-header/tag, invalid-category, dup-name;
  soft: export-mismatch, alias-collision). `files` option narrows surfacing
  to staged files.
- `packages/cairn-core/src/components/index-build.ts` — `buildComponentIndex`
  (collect → render → write under `.cairn/ground/components/` + orphan-slice
  cleanup).
- `packages/cairn-core/src/components/audit.ts` — `runComponentAudit`
  (Tailwind-utility-root Jaccard inline-rebuild + name-collision; reuses
  `jaccard` from `text/jaccard.ts`).
- `packages/cairn-core/src/components/index.ts` — barrel.
- `packages/cairn-core/src/mcp/tools/components-in-scope.ts` +
  `component-get.ts` — the two read tools.
- `packages/cairn/src/cli/components.ts` — `cairn components index|check|audit`.

### Files modified

- `packages/cairn-state/src/paths.ts` — `componentsGroundDir`,
  `componentsIndexPath`, `componentsSliceDir`, `componentSlicePath`.
- `packages/cairn-state/src/index.ts` — `export * from "./components.js"`.
- `packages/cairn-core/src/index.ts` — `export * from "./components/index.js"`.
- `packages/cairn-core/src/mcp/schemas.ts` — `componentsInScopeInput`,
  `componentGetInput`.
- `packages/cairn-core/src/mcp/errors.ts` — added `COMPONENT_NOT_FOUND` to
  the `McpErrorCode` union.
- `packages/cairn-core/src/mcp/tools/index.ts` — registered both tools in
  `allTools[]`.
- `packages/cairn-core/src/doctor/index.ts` — `checkComponents` (no-op when
  no component config; hard findings → doctor error → CI fails).
- `packages/cairn-core/src/init/source-comments/walker.ts` — `passesHeuristic`
  now drops `@cairn` headers via `isComponentHeaderBlock(b.raw)`. **This one
  edit covers the curator walker too** (`init/curator/walker.ts` reuses
  `walkSourceComments`).
- `packages/cairn/src/cli/sensor-run.ts` — **rewritten**: `--staged` now runs
  the real component check and exits 1 on hard findings (was a no-op stub).
- `packages/cairn/src/cli/index.ts` — dispatch `components` + usage line.
- `packages/cairn-core/templates/.cairn/.gitignore` — `ground/components/`
  (derived; canonical source — build mirrors it to the plugin dist).
- `packages/cairn-frontend-claudecode/skills/cairn-direction/SKILL.md` —
  Step 0 preload + Step 1 gather the registry + USE>EXTEND>CREATE ladder.

### Validation evidence (reproduce to confirm the baseline before S6)

```bash
pnpm build    # must be green first

CLI=packages/cairn-frontend-claudecode/dist/cli.mjs

# single-app fixture: index groups by category→dir, [S] singleton; check
# hard-fails missing header (exit 1) + soft-warns export mismatch; audit
# catches the value-tweaked inline rebuild (root-similarity 1.00).
node "$CLI" components index --repo /tmp/cairn-comp-fix
node "$CLI" components check --repo /tmp/cairn-comp-fix   # exit 1
node "$CLI" components audit --repo /tmp/cairn-comp-fix   # exit 0

# monorepo fixture: INDEX.md is manifest-only (no honeypot); index/<ws>.md
# slices; platform slice lists OFF-LIMITS: core (not shared ui); shared ui
# appended to platform slice.
node "$CLI" components index --repo /tmp/cairn-comp-mono
```

The fixtures under `/tmp/cairn-comp-fix` and `/tmp/cairn-comp-mono` may be
gone after a machine restart — recreate them from the **§17 smoke** shapes
below (single-app: a headered nav component, a header/export mismatch, a
missing-header file, an inline-rebuild page; monorepo: platform + core(.ts)
+ ui(shared)).

## Remaining work — execution guide

Do these in order. Keep `pnpm build` green at every step; never leave
`PHASE_IDS`/`RUNNERS`/`PhaseOutputs` half-wired.

### S6 — adoption auto-wire (the heavy piece: phase-machine surgery)

**S6.1 — auto-detect + write `components:` config at adoption.**
`overlay.ts` (`buildProjectOverlay`) is a **pure function — do not add IO
there.** Instead:

1. `packages/cairn-core/src/init/detect-components.ts` —
   `detectComponentsConfig(repoRoot): Promise<ComponentsConfig | null>`.
   **LLM-driven + convention-agnostic** (not a fixed dir-name probe).
   Adoption always runs inside an LLM coding agent, so detection asks a
   model (Sonnet via `runClaude`) rather than hardcoding conventions: a
   deterministic walk builds a structural digest (per-directory file-
   extension histogram + the dirs holding a `package.json` + workspace-
   manifest files), the model returns which workspaces carry reusable UI,
   their component dirs (wherever they sit — no `src/components` /
   `packages/*` assumption), the extensions in play, and a taxonomy fitting
   each workspace. 2+ UI workspaces → `workspaces` form keyed by package
   name, **never `shared`** (invariant 3 — operator flips manually, or the
   9e annotate step asks). Returns `null` for non-UI repos (a backend with
   no components). LLM-only by design — no deterministic fallback; "no
   model" means adoption isn't running. Detection quality is guarded by the
   opt-in `pnpm smoke:llm-detect-components` real-LLM smoke.
2. Call it in `packages/cairn-core/src/init/phases/4-seed.ts` right before
   `writeFileSync(configPath, stringifyYaml(config))`: `await` it and
   attach `config.components = detected` when non-null. (4-seed already has
   `repoRoot` + does IO.)

**S6.2 — adoption phase that builds the index + drafts singleton §INVs +
runs the audit.** Recommended shape: a single deterministic phase
`9d-components` (simpler + lower risk than the trio; the subagent
auto-annotation in S6.3 is separable). Wiring (ALL must land together):

- `packages/cairn-core/src/init/phases/types.ts` — insert `"9d-components"`
  into `PHASE_IDS` **after `"9c-emit"`, before `"10-rules-merge"`**, and add
  its entry to the `PhaseOutputs` interface (e.g. `{ skipped?: ...;
  indexed?: number; singletons_drafted?: number; audit_findings?: number }`).
  `schemaVersion` stays `3` (no state-shape change; an old in-flight
  `init-state.json` simply won't carry the new phase — fine for fresh
  adoptions).
- New `packages/cairn-core/src/init/phases/9d-components.ts` — the runner.
  Pattern: copy a small deterministic phase (e.g. `4-seed.ts` or the
  `8-docs-ingest` no-op) for the `PhaseResult`/`advancePhase` shape.
  Steps: `isSelfAdoptState(state)` → stamp `{skipped:"self-adopt"}`, advance;
  `loadComponentsConfig` + `hasComponentConfig` false → stamp
  `{skipped:"no-components"}`, advance; else `buildComponentIndex`,
  draft singleton §INVs (S6.2a), `runComponentAudit` → write findings to a
  baseline yaml (S6.2b), stamp output, advance to `10-rules-merge`.
- `packages/cairn-core/src/init/phases/index.ts` + `init/index.ts` — export
  `runPhase9dComponents`.
- `packages/cairn-core/src/mcp/tools/init-phases.ts` — add to the `RUNNERS`
  map + the `runPhase…` import block. (The generic skill loop calls
  `cairn_init_run` per `nextPhase`, so no skill-loop change is needed for a
  deterministic phase.)
- `packages/cairn-frontend-claudecode/skills/cairn-adopt/SKILL.md` — add a
  banner-registry row for `9d-components` (cosmetic; an unlisted id just
  renders no banner, but the skill says "do NOT improvise descriptions", so
  add the row). Also add its drop/skip note to the Step 5 summary fields if
  surfacing counts.

  - **S6.2a — singleton → §INV.** For each component with `@singleton`, write
    an invariant: title *"`<Name>` exists exactly once in `<workspace>`"*,
    scope = the workspace `componentDirs`. **Check the existing INV-write
    path first** — `init/sot-emit.ts` (`emitFromTopicIndex`) is how 9c-emit
    writes INV `.md` files with `sot_kind: ledger` + content-addressed ids
    (`deriveLedgerInvId`). Reuse it (or its lower-level writer) to emit the
    singleton INV body; status `active`. Enforcement of "exactly once" is the
    **check's duplicate-name logic**, NOT a generic decision-assertion —
    don't attach an assertion. The decision (D4) says "draft via attention",
    but verbatim auto-accept (like 9c) is also acceptable since the rule is
    mechanical; pick whichever matches the source-comment ingest convention
    you find in `sot-emit.ts`. Rebuild the invariants ledger after
    (`writeInvariantsLedger({repoRoot})`).
  - **S6.2b — audit findings to attention.** Write `runComponentAudit`
    findings to `.cairn/baseline/components-<ISO>.yaml` in the same shape the
    cairn-attention skill consumes baseline findings (model on
    `init/baseline-audit.ts` output + how `attention/` reads it). Missing
    headers from `buildComponentIndex.missing` should also surface here so
    the operator/agent annotates them (the daily-flow check enforces).

**S6.3 — subagent auto-annotation (OPTIONAL, riskiest; can defer).** Makes
adoption write `@cairn` headers into source automatically. Only do this if
S6.2 is green and tested. Shape mirrors the `9b-curate` skill-driven
pseudo-phase:

- Split `9d-components` into the trio `9d-comp-walk` (deterministic: list
  files missing headers → `.cairn/init/components/missing.jsonl`),
  `9e-comp-annotate` (skill-driven), `9f-comp-emit` (the S6.2 index +
  singleton + audit work, now post-annotation).
- `9e` runner just confirms annotation ran + advances (like the 9b runner
  confirms `final.jsonl`). The real work is a new **Step 3.6** in
  `cairn-adopt/SKILL.md` that dispatches annotation subagents (Task tool,
  parallel batches of ~4, like Step 3.5 curator). New agent def
  `packages/cairn-frontend-claudecode/agents/component-annotator.md` +
  `allowed-tools: Task(component-annotator)` in the cairn-adopt frontmatter.
- The annotation brief MUST inline (invariant 8): `@cairn` = exact export
  name; `@singleton` honesty (only app-shell parts the project intends once);
  `@aliases` ≥2 concrete searchable nouns; `@category` from the taxonomy;
  header is the FIRST block in the file; do not change code outside the
  comment. Per-module-batch consent (like Phase 12).

**S6.4 — standing rules.** Add the iron rule + USE>EXTEND>CREATE ladder +
singleton text to `packages/cairn-core/templates/.cairn/config/workflow.md`
(the seed substitutes `<project_name>`). The daily-flow skill already points
components there.

### S8b — Lens, smokes, docs

- **Cairn Lens** (`packages/cairn-lens/`): hover provider on `@cairn` headers
  reading `buildComponentsLedger(repoRoot)`; `[S]` singleton → active marker;
  `@cairn` ≠ export → amber drift. Mirror the existing §INV/DEC hover
  providers in that package.
- **Smokes** (§17): add the E2E smokes and wire into the `pnpm smokes` gate.
  Find the smoke registry/runner (root scripts call it; grep `smokes`).
- **`cairn fix gitignore`**: confirm the v0.15.0 gitignore-fix path (in
  `cli/fix.ts` / fix-align) lists `ground/components/` so pre-existing
  adoptions backfill the ignore.
- **Docs fold-in**: `docs/MCP_SURFACE.md` (+2 tools, bump the tool count),
  `docs/FILESYSTEM_LAYOUT.md` (`.cairn/ground/components/` + gitignore note),
  `docs/ARCHITECTURE.md` (fourth store), `docs/PLUGIN_ARCHITECTURE.md`
  (component adoption phase + daily-flow injection), `README.md` features.
  Then this plan file retires.

## Gotchas / discovered facts (read before touching the phase machine)

- **`cairn sensor-run --staged` was a no-op stub** — now the real component
  gate. The pre-commit hook shells `cairn sensor-run --staged`.
- **CI runs `cairn doctor`, not `sensor-run`** — component health is folded
  into `doctor` (`checkComponents`, no-op when no component config).
- **`init-phases.ts` tool responses are SKINNY** (`{status, nextPhase}`).
  State persists to `.cairn/init-state.json`; never echo state in responses.
  Terminal complete (`nextPhase === null`) **clears** the state file; the
  error path must **not** clobber it.
- **`9b-curate` is a skill-driven pseudo-phase** — its MCP runner only
  confirms a file exists. The 9e annotate step mirrors this exactly.
- **`overlay.ts` is pure (no IO)** — component config detection does IO in
  the phase (4-seed), not in overlay.
- **`@cairn` strict grammar**: header signal is `/@cairn[ \t]+[A-Za-z_$]/`;
  `@cairn:decision` / `@cairn:rule` are a different (colon) namespace — never
  conflate. `isComponentHeaderBlock` is the shared chokepoint.
- **One walker, two ingest paths**: `walkSourceComments` is reused by the
  curator walker, so the `passesHeuristic` exclusion already covers both.
- **Derived index gitignored** under `ground/components/` — the headers in
  source are the committed source of truth (D3).
- **Build**: `pnpm build` (per-package `tsc -b` + plugin bundle rebuild).
  Gate: `pnpm smokes`.

## 0. What this adds and why

Cairn stops agents from *drifting from recorded decisions*. It does **not**
yet stop the most expensive frontend failure mode: an agent rebuilding a
component that already exists, then misusing the refactor. This plan ports a
component-reuse-discipline prototype into Cairn as a **fourth ground store**
(alongside decisions, invariants, canonical-map), so the same session that
loads in-scope DECs/§INVs also loads the in-scope **component inventory**
before any UI work.

The mechanism is three parts:

1. **Headers in source** — every component file carries a structured
   `@cairn <ExportName>` comment. The header *is* the registry entry; it
   lives with the code so it can't drift elsewhere.
2. **A generated inventory** the agent reads *in full* before UI work — no
   retrieval step, because every retrieval (grep, folder walk, embedding) is
   a guess that misses. The full in-scope inventory is cheap enough to always
   load.
3. **A check sensor + advisory audit** — the check blocks (missing headers,
   duplicate names, stale index); the audit advises (probable inline
   rebuilds, name collisions). The two are never blurred.

The decision ladder the agent follows: **USE > EXTEND > CREATE**.

### The eight port invariants (each earned by a prototype test failure)

Every line below is load-bearing; §14 maps each to its enforcement point.

1. **Full slice reads, never retrieval.** Within a scope the agent loads the
   complete inventory. Scope-aware preload narrows *which* slice, never
   *within* a slice.
2. **The registry never lies about code.** `@cairn` = the exported name.
   Collisions become rename recommendations; mismatch warns.
3. **Isolation by default, sharing opt-in per workspace.** A wrong `shared`
   flag licenses forbidden coupling; adoption must verify imports or ask.
4. **No honeypot.** The all-workspace inventory file must not exist in
   monorepos — manifest + slices only.
5. **Advisory vs gate, never blurred.** Audit informs and never blocks;
   check blocks and never advises. Findings are operator-triaged, never
   auto-fixed.
6. **Surface requirements live in report templates.** Agents report what the
   template asks; instructions buried earlier evaporate.
7. **Generated artifacts are deterministic** — sorted, no timestamps;
   cache-stable and diff-clean.
8. **Headers are write-once-correct.** Annotation prompts carry the
   export-match and singleton-honesty rules inline, where agents read them.

## 1. Locked decisions (the fights, resolved)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Keep `@cairn <ExportName>` as the header tag.** | Brand-consistent with `.cairn/`, `cairn_*`, `@cairn:decision`. The collision with the existing `@cairn:decision`/`@cairn:rule` SoT markers is removed by a strict grammar (§2), not by renaming. |
| D2 | **The component check executes for real.** | `cairn sensor-run --staged` is currently a stub (prints "execution not yet wired", exits 0). Port-invariant 5 requires the check to *block*. The component check becomes the first real tenant of that gate, and is also folded into `cairn doctor` (which CI runs). |
| D3 | **Derived index gitignored; headers are the committed SoT.** | Per the v0.15.0 gitignore-derived-ground-state decision. `.cairn/ground/components/` is a rebuildable cache; `@cairn` headers in source are the truth. |
| D4 | **`@singleton` → §INV draft via the attention queue.** | Singletons become real invariants, but as drafts the operator triages — never a silent bulk write that floods ground state. |
| D5 | **Full monorepo support from the start.** | Workspaces, per-workspace slices, manifest, isolated/shared policy, OFF-LIMITS lists. Matches real multi-package repos. |
| D6 | **Breaking changes allowed.** | The source prototype was a fast spike; we flesh it out correctly. No back-compat shims, no legacy tag forms. |
| D7 | **State logic in `cairn-state`; sensors/MCP/CLI/phases in `cairn-core`.** | Mirrors the existing package boundary (`cairn-state` = schemas + low-level I/O + readers; `cairn-core` = MCP + sensors + init). |

## 2. The `@cairn` comment namespace (strict grammar)

`@cairn` now appears in source comments in two disjoint forms. They never
collide because the grammar is anchored:

| Form | Syntax | Meaning | Detector |
|------|--------|---------|----------|
| **Registry header** | `@cairn <ExportName>` (whitespace + identifier) | This file's component-registry entry. | `/@cairn[ \t]+[A-Za-z_$]/` |
| **SoT marker** (pre-existing) | `@cairn:decision` / `@cairn:rule` (colon) | Force this comment block to emit a DEC/INV during ingest. | `/@cairn:(decision\|rule)/i` |

Citations (`§DEC-…`, `§INV-…`) and `// TODO(TSK-…)` are unaffected — different
sigils.

**Precedence + exclusion rules (enforced in code):**

- A block whose first `@cairn` is the colon-form is a **marker**, never a
  header. The header detector requires whitespace then an identifier start, so
  `@cairn:decision` can never be misread as a header. (The prototype's
  `.includes('@cairn')` parse is replaced by this anchored regex.)
- A block that **is** a registry header is excluded from source-comment /
  curator candidate registration. `isComponentHeaderBlock(raw)` is exported
  from `cairn-state` and called by `init/source-comments/walker.ts` and
  `init/curator/walker.ts` so headers never pollute the topic index and are
  never stripped by Phase 12.

**Header forms accepted** (framework-agnostic; defaults React-flavored):

1. **Block form** — the first `/** */` comment in the file. TS/JS, Vue/Svelte
   script blocks, Swift, Kotlin, Dart, Java, C#.
2. **Hash form** — the first contiguous run of `#` lines (an opening `#!`
   shebang is skipped). Python, Ruby, shell, YAML, Elixir.

**Tags.** Required: `@cairn` (exact export name, unique per workspace),
`@category` (from the per-project taxonomy), `@purpose` (one searchable line),
`@aliases` (≥2, comma-separated). Optional: `@props`, `@uses`, `@singleton`
(valueless), `@status` (`stable|wip|deprecated`), `@example`. Tag-line parse:
`/@([a-z]+)\b(?:[ \t]+(.+))?/i`; a valueless tag stores `"true"`.

## 3. Data model

### 3.1 `config.yaml` — the `components:` section

`.cairn/config.yaml` gains one top-level key. **Single-app form:**

```yaml
components:
  componentDirs: [src/components, src/features]
  extensions: [".tsx", ".jsx"]
  categories: [layout, navigation, data-display, forms, feedback, overlay, media, marketing, utility]
  exclude: [node_modules, dist, .next, build, coverage]
```

**Monorepo form** (`workspaces` keyed by name; each inherits top-level
`exclude`/`extensions`/`categories` unless overridden):

```yaml
components:
  exclude: [node_modules, dist, .next, build, coverage]
  workspaces:
    platform: { componentDirs: [platform/src/components] }
    site:     { componentDirs: [site/src/components] }
    core:
      componentDirs: [core/src/modules]
      extensions: [".ts"]
      categories: [service, controller, dto, guard, interceptor, util]
    ui:
      componentDirs: [packages/ui/src]
      shared: true          # opt-in; everything else is isolated
```

Component names are unique **per workspace**, not globally. Phase 3 (mapper)
proposes this block; ambiguous `shared` flags trigger an `AskUserQuestion`
(invariant 3).

### 3.2 Ground store layout — `.cairn/ground/components/`

| Path | When | Content |
|------|------|---------|
| `components/INDEX.md` | single-app | Full flat inventory, category→dir grouped. |
| `components/INDEX.md` | monorepo | **Manifest only** — workspace→path table + sharing policy. No inventory (honeypot invariant). |
| `components/index/<ws>.md` | monorepo | One workspace's slice: own components + `[shared]` workspaces + OFF-LIMITS name list. |

All of these are **derived** (§3.4). Line format (deterministic, sorted):
`Name [S]? | aliases | purpose` with `file:` suffix only when the filename
differs from the component name.

### 3.3 Schemas + types (in `cairn-state`)

```ts
// config (zod, parsed from config.yaml `components:`)
export const ComponentsWorkspaceConfig = z.object({
  componentDirs: z.array(z.string()).default([]),
  extensions:    z.array(z.string()).optional(),
  categories:    z.array(z.string()).optional(),
  exclude:       z.array(z.string()).optional(),
  shared:        z.boolean().optional(),
}).passthrough();

export const ComponentsConfig = z.object({
  componentDirs: z.array(z.string()).optional(),
  extensions:    z.array(z.string()).optional(),
  categories:    z.array(z.string()).optional(),
  exclude:       z.array(z.string()).optional(),
  workspaces:    z.record(z.string(), ComponentsWorkspaceConfig).optional(),
}).passthrough();

// normalized runtime shape (flat config → one workspace, name "")
export interface ComponentWorkspace {
  name: string;            // "" = single-app
  componentDirs: string[];
  exclude: string[];
  extensions: string[];
  categories: string[];
  shared: boolean;
}

// a parsed header + its file
export interface ComponentTags {
  cairn: string; category?: string; purpose?: string; aliases?: string;
  props?: string; uses?: string; singleton?: string; status?: string;
  example?: string; [k: string]: string | undefined;
}
export interface ComponentRecord {
  file: string;            // repo-relative POSIX
  workspace: string;
  tags: ComponentTags;
  exportName: string | null;
}

// derived ledger entry — for Lens + MCP tools
export interface ComponentLedgerEntry {
  name: string; workspace: string; file: string;
  category: string; purpose: string; aliases: string[];
  singleton: boolean; status?: string; uses: string[];
}
```

Defaults (`DEFAULT_CATEGORIES`, `DEFAULT_EXTENSIONS`, `DEFAULT_EXCLUDE`,
`REQUIRED_TAGS`) live next to these.

### 3.4 Derived vs committed (gitignore)

The derived index is added to the seeded `.cairn/.gitignore` next to the
other derived ground state:

```gitignore
# Derived component index — rebuilt from @cairn source headers by
# `cairn components index` + SessionStart. Committing it causes multi-dev
# merge churn; the headers in source are the committed source of truth.
ground/components/
```

`cairn fix gitignore` untracks it on repos adopted before this lands.

## 4. Module placement

```
cairn-state/src/
  components.ts          parse / walk / collect / render / validate / config-load
  schemas.ts             + ComponentsConfig zod
  paths.ts               + componentsGroundDir / componentsIndexPath / componentSlicePath   [DONE]
  index.ts               + export components.js

cairn-core/src/components/
  index-build.ts         collect + render + write index, orphan-slice cleanup
  check.ts               validate → SensorFinding[]  (the gate)
  audit.ts               Jaccard inline-rebuild + name-collision (advisory)
  in-scope.ts            resolve workspace(s) for path globs → inventory
  singleton-inv.ts       @singleton → §INV draft emitter

cairn-core/src/mcp/tools/
  components-in-scope.ts  cairn_components_in_scope
  component-get.ts        cairn_component_get

cairn/src/cli/components.ts   cairn components index|check|audit
```

Reuses existing primitives: `walkFs`, `matchAnyGlob`/`matchGlob` (glob),
`jaccard` (text), `parseFrontmatter` patterns, `SensorFinding`/`SensorResult`
types. No re-porting of raw fs loops.

## 5. Monorepo model

- **Manifest** (`INDEX.md`): workspace → component-dir table, slice path,
  component count, and the sharing-policy banner. Carries no inventory.
- **Slices** (`index/<ws>.md`): own inventory + each `[shared]` workspace's
  inventory + an OFF-LIMITS list naming the isolated workspaces (awareness,
  not an invitation).
- **Isolation policy.** Isolated by default. `shared: true` makes a
  workspace's components appear in every slice and usable everywhere. The
  decision ladder applies across a shared boundary; nothing is promoted into
  a shared workspace except by the operator.
- **Read enforcement replaces the prototype's PreToolUse guard.** The
  prototype mechanically blocked out-of-scope slice reads via a `PreToolUse`
  hook. **Cairn bans `PreToolUse`** (it can brick the session). The
  replacement is: (a) the daily-flow skill injects only the in-scope slice
  into the tightened spec (§11), and (b) `cairn_components_in_scope` returns
  only the entitled workspace(s). This is advisory-by-construction rather than
  a hard kernel block — the honest trade for not shipping a session-bricking
  hook. The mechanical teeth that remain are the **check** (duplicate names,
  missing headers) and the full-slice-read being the agent's first move.

## 6. The component check sensor — making `sensor-run` real

`cairn-core/src/components/check.ts` exposes
`runComponentCheck(repoRoot, { stagedOnly?, files? })` returning
`SensorFinding[]`:

| Finding | Severity |
|---------|----------|
| Scanned component file with no header | hard |
| Missing required tag (`@cairn`/`@category`/`@purpose`/`@aliases`) | hard |
| `@category` not in the workspace taxonomy | hard |
| Duplicate `@cairn` name within a workspace | hard |
| Derived index stale / orphan slice present | hard (rebuildable — see note) |
| `@cairn` ≠ detected export name | **soft** (warn) |
| Alias claimed by two components | **soft** (warn) |

Wiring:

- **Pre-commit:** replace the `cairn sensor-run` stub body. On `--staged`,
  load staged files, run `runComponentCheck({ stagedOnly: true })`, print
  findings, **exit 1 on any hard finding.** This gives the pre-commit gate its
  first real execution path.
- **CI:** the workflow already runs `cairn doctor`. Add a component-health
  block to `doctor` that rebuilds the index in memory and runs the check;
  hard findings fail `doctor` → fail CI. (Staleness is moot in CI since the
  index is derived — doctor rebuilds and compares in-memory.)
- **Attention:** the check also feeds the attention queue at adoption
  (baseline) so missing-header debt surfaces for triage rather than blocking
  the first commit (pre-adoption violations go to baseline, per the existing
  CI `--diff origin/main..HEAD` net-change contract).

## 7. The component audit (advisory)

`cairn-core/src/components/audit.ts` — read-only, always exits 0, findings are
triage input:

1. **Probable inline rebuilds.** For each `className` list (≥3 classes) in
   non-component files, compare against indexed components on **Tailwind
   utility roots** (`max-w-2xl` → `max-w`, so value-tweaked copies still
   match) using `jaccard(Set,Set)`. Threshold 0.7, ≥3 shared roots. Emits an
   EXTEND recommendation.
2. **Name collisions.** `@cairn` names that collide with a `type`/`interface`
   name elsewhere → rename recommendation.

Surfaces: Phase 11 baseline addition + `cairn components audit` on demand →
attention-queue drafts.

## 8. MCP surface

Two read tools, registered in `mcp/tools/index.ts` `allTools[]`:

- **`cairn_components_in_scope({ path_globs })`** — resolve the workspace(s)
  the globs touch (longest-prefix match against `componentDirs`), return that
  workspace's inventory plus any `[shared]` workspace's, plus the OFF-LIMITS
  name list. Single-app → the whole inventory. Models on `cairn_in_scope`.
- **`cairn_component_get({ name, workspace? })`** — return one component's
  ledger entry + raw header (`@props`/`@example` for correct usage). Models on
  `cairn_invariant_get`.

Both are read-only (no bootstrap guard). The MCP surface count and
`docs/MCP_SURFACE.md` update accordingly.

## 9. CLI

`cairn components <sub>` (new `cli/components.ts`, dispatched from
`cli/index.ts`):

- `index` — rebuild `.cairn/ground/components/` from headers; print token
  cost + missing-header count; clean orphan slices.
- `check` — run the check; exit 1 on hard findings (the manual/CI form).
- `audit` — run the advisory audit; always exit 0.

The prototype's `index`/`scope`/`guard` scripts retire: `scope`/`guard` are
replaced by scope-aware preload + the MCP tools (§5).

## 10. Adoption pipeline — new phase trio

The source prototype ran annotation as a separate manual session. In Cairn it
becomes a phase trio mirroring the curator's walk→curate→emit shape, slotted
after `9c-emit`:

| Phase id | Kind | Job |
|----------|------|-----|
| `9d-comp-walk` | deterministic | Detect component dirs/workspaces (from Phase 3 mapper output), walk them, list files missing `@cairn` headers, write a corpus. No-op when no `components:` config. |
| `9e-comp-annotate` | skill-driven subagent | The cairn-adopt skill dispatches annotation subagents (parallel batches, like `curator-map`) that write `@cairn` headers into source files. The annotation brief carries the export-match + singleton-honesty rules inline (invariant 8). Per-batch consent like Phase 12. |
| `9f-comp-emit` | deterministic | Run `cairn components index`, validate, draft a §INV per `@singleton` (→ attention), and run the audit (→ attention). |

Touch points: `PHASE_IDS`, `PhaseOutputs`, the `RUNNERS` map in
`init-phases.ts`, and the cairn-adopt `SKILL.md` driver (a new Step 3.6 for
the `9e` subagent dispatch, parallel to the existing 3.5 curator step). Phase 3
mapper + `overlay.ts` gain the `components:` proposal; ambiguous `shared`
detection surfaces an `AskUserQuestion`.

**Gate:** the whole trio no-ops when Phase 3 detected no component dirs, so
non-UI repos are unaffected. Self-adopt (`CAIRN_SELF_ADOPT=1`) short-circuits
it like the other ingest phases.

## 11. Daily-flow injection (`cairn-direction`)

- **Step 0 preload:** add `mcp__plugin_cairn_cairn__cairn_components_in_scope`
  and `…cairn_component_get` to the batch `ToolSearch`.
- **Step 1 gather:** call `cairn_components_in_scope({ path_globs })`
  alongside `cairn_in_scope` and inject the returned inventory into the
  tightened spec. This is the "full slice read" — narrowed to the in-scope
  workspace, never narrowed within a slice (invariant 1).
- **Spec template:** the tightened-spec template gains a "Components in scope"
  section + the USE > EXTEND > CREATE ladder line so the surface requirement
  rides the template, not buried prose (invariant 6).

The ladder/iron-rule text also lands in `.cairn/config/workflow.md` so it is
part of the project's standing rules.

## 12. Singletons → §INV drafts

`@singleton` headers auto-draft an invariant: *"`<Name>` exists exactly once in
`<workspace>`"*, scope = the workspace `componentDirs`. Written via the same
draft→attention path as DEC drafts (`sot_kind: ledger`, body states the rule).
Enforcement of "exists exactly once" is the **check's** duplicate-name logic
(not a generic decision-assertion). Lens renders it; the check enforces it.

## 13. Cairn Lens

`cairn-lens` reads the new component ledger from `cairn-state`
(`buildComponentsLedger`): hover on a `@cairn` header shows the registry
entry; `[S]` singletons render with the active-invariant marker; a component
whose header `@cairn` ≠ export shows the amber "drift" status.

## 14. Port invariants → enforcement points

| # | Invariant | Enforced by |
|---|-----------|-------------|
| 1 | Full slice reads, never retrieval | `cairn_components_in_scope` returns whole slice; direction Step 1 injects it (§11) |
| 2 | Registry never lies about code | check soft-warn on `@cairn`≠export; audit name-collision; required-export-match in annotation brief |
| 3 | Isolation default, share opt-in | config `shared` flag; Phase 3 verifies imports / asks; slices carry OFF-LIMITS |
| 4 | No honeypot | monorepo render emits manifest + slices only, never an all-workspace file (§3.2) |
| 5 | Advisory vs gate never blurred | `check.ts` exits 1 (gate); `audit.ts` exits 0 (advisory); both feed attention, neither auto-fixes |
| 6 | Surface reqs in report templates | tightened-spec template + annotation report checklist carry the requirements (§11, §10) |
| 7 | Deterministic artifacts | render sorts, omits timestamps; `cairn components check` flags any stale/orphan output |
| 8 | Headers write-once-correct | annotation brief inlines export-match + singleton-honesty rules (§10) |

## 15. Staged build order (file-level)

Status is tracked in the **⛳ RESUME HERE** section at the top; the file-level
intent per stage is below.

| Stage | Status | Deliverable | Files |
|-------|--------|-------------|-------|
| **S1** | ✅ done | State foundation | `cairn-state/src/components.ts` (new), `paths.ts`, `index.ts` |
| **S2** | ✅ done | MCP tools | `mcp/tools/components-in-scope.ts`, `component-get.ts`, register in `tools/index.ts`; `mcp/schemas.ts` inputs; `mcp/errors.ts` (+`COMPONENT_NOT_FOUND`) |
| **S3** | ✅ done | Check + real wiring | `core/components/check.ts`, `index-build.ts`; rewrote `cli/sensor-run.ts`; extended `doctor/index.ts` |
| **S4** | ✅ done | Audit | `core/components/audit.ts` |
| **S5** | ✅ done | CLI | `cli/components.ts`, dispatch in `cli/index.ts` |
| **S6** | ✅ done | Adoption auto-wire | `init/detect-components.ts`, `4-seed.ts` (`components:`). **Adoption trio** (S6.3 landed): `init/phases/9d-comp-walk.ts` (lists un-headered files → `.cairn/init/components/missing.jsonl`) → `9e-comp-annotate.ts` (skill-driven, tolerant confirm) → `9f-comp-emit.ts` (index + singleton→§INV + audit). All wired into `PHASE_IDS`/`PhaseOutputs`/`RUNNERS`; `9c-emit → 9d-comp-walk`, no-config skips the trio to `10-rules-merge`. Singleton §INV written directly as `status: active` (NOT `sot-emit.emitInv`, which stamps `accepted` → ledger drops it). Audit+missing → `baseline/components-<ISO>.yaml`. `cairn-adopt/SKILL.md` banner+Step 3.6+summary, new `agents/component-annotator.md` (+`Task(component-annotator)`), `cairn-attention/SKILL.md` reads the component baseline, `workflow.md` template. |
| **S7** | ✅ done | Daily flow | `cairn-direction/SKILL.md` Steps 0/1; walker exclusion in `source-comments/walker.ts` (covers curator) |
| **S8a** | ✅ done | Derived gitignore | `templates/.cairn/.gitignore` |
| **S8b** | ✅ done | Lens + smokes + docs | `cairn-lens` hover on `@cairn` headers; `smoke-components.ts` wired into `pnpm smokes`; `cairn fix gitignore` backfill is template-driven (no code change — diffs template vs live, untracks `ground/components/`); folded into ARCHITECTURE/PLUGIN_ARCHITECTURE/MCP_SURFACE/FILESYSTEM_LAYOUT/README |

Each stage builds + typechecks green before the next. S1 is the hard
dependency for everything; **S6 is the only large remaining piece.**

## 16. Breaking changes (allowed — no shims)

- `cairn sensor-run --staged` changes from a silent pass to a real gate that
  can exit 1. Any repo relying on its no-op behavior will start failing on
  component violations — intended.
- New required `.cairn/.gitignore` entry; `cairn fix gitignore` backfills.
- `cairn doctor` gains a failing component-health check.
- The prototype's `@ab` tag, `alignmentboss/` dir, and `ab-*` scripts do not
  exist in Cairn — only `@cairn` headers carry over.

## 17. Smokes (E2E with real fixtures — no unit-test framing)

- Single-app fixture: headered components → `cairn components index` →
  `check` exits 0; remove a header → `check` exits 1; tweak a class in a page
  → `audit` flags the inline rebuild.
- Monorepo fixture: manifest + slices render; isolated workspace's components
  never appear in another slice; `cairn_components_in_scope` returns only the
  entitled slice + shared; duplicate name across workspaces is allowed,
  within a workspace fails.
- Pre-commit smoke: staged component file missing a header blocks the commit.
- Adoption smoke: a UI fixture runs the `9d/9e/9f` trio, ends with a clean
  `check` + a singleton §INV draft in the attention queue.

## 18. Open risks / deferred

- **Read enforcement is advisory, not a kernel block** (§5) — accepted, given
  the `PreToolUse` ban. If misuse shows up in practice, the lever is a
  Stop-hook check that flags out-of-scope slice reads after the fact, not a
  pre-tool block.
- **Audit is Tailwind-class-based** — CSS-modules / styled-components are
  invisible until v2.
- **v2 (deferred): rendered verification.** Headless render + perceptual-hash
  duplicate detection (catches renamed/restyled rebuilds the lexical audit
  misses) and design-rule checks on computed layout (spacing scale, contrast,
  overflow, breakpoints) as additional sensor layers — the unoccupied gap
  beyond static source lint.
</content>
</invoke>
