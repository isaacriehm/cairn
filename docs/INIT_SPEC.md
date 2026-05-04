---
type: spec
status: draft-v1
audience: dual
generated: 2026-05-04
depends-on:
  - docs/PRIMER.md (§9)
  - docs/FILESYSTEM_LAYOUT.md
  - docs/DAEMON_SPEC.md
---

# Harness — Init Spec

`harness init` is the front door of Harness. It adopts any project in one pass with minimal operator friction. This doc specifies the full init flow, what it detects, what it writes, and the UX rules it follows.

---

## 1. Invocation

```bash
npx @devplusllc/harness init [repo-path]
# or, if globally installed:
harness init [repo-path]
```

`repo-path` defaults to `cwd`. Must be a git repo root (or a subdirectory — init walks up to find the git root).

---

## 2. UX rules (non-negotiable)

These rules govern every interaction in the init flow:

1. **At most 2 questions per dialog turn.** If the mapper proposes 10 sensors, operator sees one dialog: "Here's what I found. [Looks right | Edit list | Skip sensors for now]." Not 10 sequential yes/no prompts.
2. **Every question has a smart default.** The operator can press Enter on every prompt and get a working setup. No question with no default.
3. **`/ship-anyway` at any point.** Operator can type `/ship-anyway` to accept all remaining defaults and skip to writing.
4. **Nothing is irreversible.** Every init output can be re-run or overridden. No "are you sure?" gates.
5. **Harness never overwrites existing files it didn't create**, except `AGENTS.md` (merges, doesn't overwrite) and `.harness/config/` (updates `<slug>:` block only, leaves rest intact on re-init).

---

## 3. Init phases

### Phase 1: Live discovery (streamed to terminal, no operator input)

This phase runs in full view. The operator watches it happen — they don't answer questions, they watch Harness figure out their project.

```
  Scanning /Users/you/projects/my-crm...

  Stack
    ✓ TypeScript          tsconfig.json
    ✓ NestJS              src/app.module.ts, @nestjs/core
    ✓ Drizzle ORM         drizzle.config.ts
    ✓ OpenAPI spec        openapi.json  (47 endpoints)
    ✓ Jest                jest.config.ts

  Docs
    ✓ docs/               12 files found
    ✓ AGENTS.md           exists, 128 lines
    ✓ .claude/rules/      4 rules

  Modules
    ✓ src/integrations/   6 services, 3 controllers
    ✓ src/auth/           2 services, 2 controllers
    ✓ src/billing/        4 services, 1 controller  ← high-stakes candidate
    ✓ src/dashboard/      3 services, 5 controllers
    ... 4 more

  Generators
    ✓ schema-dump         drizzle schema → .harness/ground/schema/
    ✓ openapi-routes      openapi.json  → .harness/ground/routes/

  Sensors
    ✓ lint                eslint config detected
    ✓ tsc                 tsconfig.json detected
    ✓ schema-drift        drizzle detected
    ✓ openapi-drift       openapi.json detected
    ✓ stub-catalog        ~30 patterns (TypeScript profile)
    ✓ attestation         always active
    ✓ decision-assertions always active
    ✓ route-handler-non-empty  NestJS detected

  Mapping codebase...   ████████████████  done
```

Each item prints as it's found — not after a batch completes. The spinner on "Mapping codebase" is the only wait. The operator sees the full picture before anything is confirmed.

**Re-init detection:** if `.harness/` already exists, init switches to update mode and only shows what changed since last init.

### Phase 2: Repo summary (concurrent with Phase 1 tail)

While the terminal is printing Phase 1 output, the walker is building a gitignore-aware, token-bounded repo summary for the mapper. No operator wait — this runs in background during discovery display.

- Walk canonical zone (excluding `.archive/`, `node_modules/`, build artifacts)
- Cap at ~20,000 tokens
- Prioritize: existing `docs/`, `AGENTS.md`, schema files, route/controller files, `package.json` / `pyproject.toml`

### Phase 3: LLM mapper (chunked parallel — runs while Phase 1 is printing)

**Why not one call:** A single mapper call receiving a token-bounded flat summary of a large monorepo produces degraded proposals. The summary has to compress everything into ~20k tokens, which loses module-level detail. The mapper makes broad guesses rather than targeted sensor proposals.

**The actual approach: parallel per-module calls + cheap merge.**

Phase 2 identifies top-level modules (packages, apps, submodules). Phase 3 dispatches one Sonnet call *per module* in parallel, each receiving a focused deep view of its slice. A final cheap Haiku merge call synthesizes the results.

```
mypalcrm/
  core/      → Sonnet A  →  ModuleProposal
  platform/  → Sonnet B  →  ModuleProposal
  phone-ai/  → Sonnet C  →  ModuleProposal
  site/      → Sonnet D  →  ModuleProposal
                  ↓
          Haiku merge  →  MapperProposal
```

Wall-clock time is similar to one sequential call since module calls are parallel. Signal quality per module is dramatically better — each call sees its full package.json, representative service/controller/schema files, and local docs without lossy compression.

**Per-module call input (~8k tokens each):**
- Full directory tree for the module (paths only, no content)
- `package.json` / `pyproject.toml` full contents
- Up to 5 representative files (heuristic: most-imported file, index.ts/main.ts, largest controller, schema root)
- Module-level README or docs if present
- Existing decisions/invariants in scope of this module (from ledger, if any)

**Per-module call output (`ModuleProposal`):**
```ts
interface ModuleProposal {
  moduleName: string;
  moduleSlug: string;
  modulePath: string;
  domain: string;                    // one-line description
  sensorProposals: SensorProposal[];
  highStakesGlobs: string[];
  offLimitsGlobs: string[];
  pilotModuleCandidate: boolean;     // true if highest change-velocity guess
  confidence: number;
}
```

**Merge call input:** all ModuleProposals + top-level package.json / pnpm-workspace.yaml. Haiku merges them into the final MapperProposal, deduplicates overlapping sensor proposals, picks the pilot module, and sets top-level globs.

**Final output (`MapperProposal`):**
```ts
interface MapperProposal {
  projectSlug: string;
  projectName: string;
  domain: string;
  pilotModule: string;
  modules: ModuleProposal[];
  sensorProposals: SensorProposal[];
  generatorProposals: GeneratorProposal[];
  offLimitsGlobs: string[];
  highStakesGlobs: string[];
  moduleGlobs: string[];
  canonicalMapSeed: TopicEntry[];
  scopeIndex: ScopeIndexProposal;
  agentsMdAppend: string | null;
  decDraftProposals: DecDraftProposal[];
  confidence: number;
}

interface ScopeIndexProposal {
  files: Record<string, {
    decisions: string[];
    invariants: string[];
    unscoped?: boolean;
  }>;
}
```

**Progress display** while calls run in parallel:
```
  ↻  Analyzing codebase…
       core/        ✓  (8s)
       platform/    ✓  (12s)
       phone-ai/    ↻  analyzing…
       site/        ↻  analyzing…
```

Each line updates in-place as its call completes. Operator sees real progress instead of a single hanging spinner.

**Scope index seeding.** Each module call classifies its files into the scopeIndex — mapping file path → `{decisions[], invariants[]}`. The merge call assembles per-module scope indexes into the final ScopeIndexProposal. Operators don't see this directly during init — written as part of Phase 5 outputs and consumed by PostToolUse hooks + GC at runtime per `DOCS_SPEC.md` §3.8.

**Fallback:** If a module call fails, skip that module, note it in the proposal with `confidence: 0`. If all module calls fail, fall back to the legacy single-call path with the flat 20k-token summary. If merge call fails, use ModuleProposals directly without synthesis.

When `--skip-mapper`, all calls fail, or final `confidence < 0.4`: an empty `{ generated, files: {} }` skeleton is written. Operator can re-run `harness scope rebuild` later to populate.

#### Comment extraction → DEC drafts

During Phase 3, the mapper scans source files for **heavyweight comments** — JSDoc blocks or inline comments longer than 5 lines. For each one found, it evaluates whether the content describes a binding decision, a constraint, or a security rationale that should be captured as a DEC rather than living in source comments.

```ts
interface DecDraftProposal {
  sourceFile: string;
  lineRange: [number, number];
  commentPreview: string;          // first 2 lines of the comment
  proposedTitle: string;
  proposedRationale: string;
  confidence: 'high' | 'medium';   // high = clear decision, medium = maybe
}
```

These proposals are **not shown during init unless the operator asked for them** (init stays fast and frictionless). They are written to `decisions/_inbox/` as `status: draft-from-init` and appear at the operator's next session start in the pending drafts section — same as any other DEC draft. The operator reviews them there, confirms or discards each one.

This prevents the anti-pattern where AI-written essay JSDoc accumulates across runs. At adoption time, the mapper surfaces the backlog; at session start, the operator clears it at their own pace.

### Phase 4: One confirm (defaults to yes)

After Phase 1 finishes printing, show a single line:

```
  Pilot module: src/integrations/  (suggested — highest change velocity)

  Press Enter to write, or type a different path › _
```

That's it. One line. Operator presses Enter or types a correction. Everything else is accepted as-is.

If operator wants to tweak sensors or generators, that's `harness config` after init — not part of the init flow. Init's job is to get running, not to be comprehensive.

### Phase 5: Write outputs

Write everything in one pass. No further operator interaction.

#### 5.1 Directory layout

Create the full `.harness/` tree per `FILESYSTEM_LAYOUT.md`. Seed templates from `packages/harness-core/templates/`.

Template substitution variables (all derived from mapper proposal + detection, no operator input):
- `{{project_name}}` → mapper `projectName`
- `{{project_slug}}` → mapper `projectSlug`
- `{{pilot_module}}` → mapper `pilotModule`
- `{{today}}` → ISO 8601 date

#### 5.2 `workflow.md` — write `<slug>:` extension block

The core `workflow.md` template is project-agnostic. Init appends the `<slug>:` block at the bottom:

```yaml
# Auto-generated by harness init. Edit freely.
my-crm:
  pilot_module: src/integrations/
  module_globs:
    - src/**/*.module.ts
    - src/**/*.service.ts
  high_stakes_globs:
    - src/billing/**
    - src/auth/**
    - src/payments/**
  off_limits_globs:
    - AGENTS.md
    - .claude/rules/brand/**
  sensors:
    - lint
    - tsc
    - schema-drift
    - openapi-drift
    - stub-catalog
    - attestation
    - decision-assertions
    - route-handler-non-empty
  generators:
    - schema-dump
    - openapi-routes
```

#### 5.3 `.mcp.json`

```json
{
  "mcpServers": {
    "harness": {
      "command": "npx",
      "args": ["-y", "@devplusllc/harness", "mcp", "serve"],
      "env": {}
    }
  }
}
```

#### 5.4 `.claude/settings.json`

Writes the SessionStart hook entry. If `.claude/settings.json` already exists: merges the hooks array, does not overwrite other entries.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx @devplusllc/harness hook session-start"
          }
        ]
      }
    ]
  }
}
```

#### 5.5 `AGENTS.md`

- If absent: create from template (TOC pattern, ~50 lines, project-agnostic)
- If present: append the mapper's suggested `agentsMdAppend` block (if any) under a `## Harness` heading. Never modifies existing content.

#### 5.6 `sensors.yaml` + `stub-patterns.yaml`

Seed from templates + mapper proposal. Sensors not in the proposal are commented out (not deleted) so operator can see what's available.

#### 5.7 Initial ground state

Run all proposed generators that are available (generator command exists on PATH):
- Schema dump → `.harness/ground/schema/`
- OpenAPI routes → `.harness/ground/routes/`

Populate manifest from full canonical-zone walk.

Seed `canonical-map/topics.yaml` from mapper's `canonicalMapSeed`.

Seed `scope-index.yaml` from mapper's `scopeIndex` proposal. The file lives at `.harness/ground/scope-index.yaml` (see `FILESYSTEM_LAYOUT.md` §1 + `DOCS_SPEC.md` §3.8). When the mapper output is empty (`--skip-mapper`, mapper failure, or `confidence < 0.4`), an empty `{ generated: <today>, files: {} }` skeleton is written so PostToolUse hooks can find the file and treat lookups as "no scope known." The operator can re-run `harness scope rebuild` later to populate.

#### 5.8 `.gitignore` additions

Append to `.gitignore` (only lines not already present):

```
# harness runtime state
.harness/runs/
.harness/inbox/
.harness/transcripts/
.harness/staleness/log.jsonl
.harness/staleness/current.json
.harness/ground/decisions/_inbox/
```

### Phase 6: Completion output

```
✓ Harness initialized for my-crm

  Ground state:     .harness/ground/ (8 files)
  MCP server:       .mcp.json (registered)
  SessionStart:     .claude/settings.json (hook registered)
  Sensors:          8 active
  Generators:       2 active (schema-dump, openapi-routes)

Next: run `harness watch` to start the daemon, then open Claude Code.
      The MCP server and SessionStart hook are live immediately.

Docs: docs/PRIMER.md · docs/MCP_SURFACE.md · docs/DOCS_SPEC.md
```

No wall of text. One clean summary. The operator can start using it immediately.

---

## 4. Re-init (`harness init --update`)

Re-runs phases 1–4 against an existing adoption. Diffs the new mapper proposal against current config and shows only what changed:

```
Harness re-init — changes detected:

  New sensors proposed: dto-no-fake-fields, event-labels-coverage
  New generator proposed: event-registry → .harness/ground/events/
  pilot_module unchanged

[A] Apply all changes
[B] Review individually
[C] Cancel
```

Re-init never touches existing decisions, invariants, or archived content.

---

## 5. What init does NOT do

- Does not install dependencies (`npm install`, `pnpm install`)
- Does not configure a frontend adapter (Discord, Notion, CLI) — those are `harness install <adapter>`
- Does not set up a system service — that's `harness daemon start`
- Does not run any agent — that's `harness run`
- Does not ask for secrets, API keys, or credentials
- Does not require network access (LLM mapper call is the only network call; skipped if offline with a warning)

---

## 6. Frontend adapter setup (`harness install <adapter>`)

Frontend adapters are installed separately from init. This keeps init fast and frictionless.

```bash
harness install discord    # Discord bot adapter
harness install notion     # Notion adapter
harness install cli        # CLI adapter (default if nothing else installed)
```

Each `harness install` command runs its own targeted setup wizard (bot token, guild ID, etc.) and registers the adapter in `workflow.md`. Adapters can be changed or added at any time — they don't affect the core harness state.

The CLI adapter is the fallback — if no adapter is installed, `harness run` falls back to terminal I/O for any dialog that would go to the frontend.
