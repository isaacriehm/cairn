---
name: cairn-adopt-components
description: Backfill the Cairn component store into a project that was adopted before the component store shipped.
when_to_use: |
  Use when the operator wants the component store on a repo that already
  has `.cairn/` but no `components:` config (adopted before v0.18.0), or
  asks to "adopt components", "backfill the component registry", or "add
  `@cairn` headers". Drives detect → annotate → emit inline. Skip when
  the repo isn't adopted at all (send to cairn-adopt first) or already
  carries a built component store.
allowed-tools: Skill(cairn:cairn-attention), Task(component-annotator), AskUserQuestion
---

# Skill: cairn-adopt-components

You are backfilling Cairn's **component store** into an already-adopted
project — the one-time work the adoption pipeline does for fresh repos,
applied to a repo that predates the store. The goal: every component
file carries a `@cairn` registry header, the derived index is built, and
`@singleton` headers become §INVs. Spec: `docs/PLUGIN_ARCHITECTURE.md`
§6 (the component trio 9d→9e→9f) and `docs/COMPONENT_STORE_PLAN.md`.

This skill drives the bundled CLI internally
(`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" components …`). **Never
surface a CLI subcommand to the operator** (Plugin spec §11) — the chat
shows progress + consent gates, not commands.

## Step 0 — classify the repo

Run this single probe to decide whether backfill applies:

```bash
node -e '
  const fs=require("node:fs");
  const path=require("node:path");
  const root=process.cwd();
  const cfg=path.join(root,".cairn","config.yaml");
  const idx=path.join(root,".cairn","ground","components");
  if(!fs.existsSync(path.join(root,".cairn"))){console.log("not-adopted");process.exit(0);}
  if(!fs.existsSync(cfg)){console.log("not-adopted");process.exit(0);}
  let hasBlock=false;
  try{hasBlock=/^components:/m.test(fs.readFileSync(cfg,"utf8"));}catch{}
  const hasIndex=fs.existsSync(idx)&&fs.readdirSync(idx).length>0;
  if(hasBlock&&hasIndex){console.log("has-store");process.exit(0);}
  console.log("backfill");'
```

Branch:

- **`not-adopted`** → the repo has no Cairn state. Surface one line:
  "This project isn't adopted yet — run `/cairn:cairn-adopt` first; it
  builds the component store as part of adoption." End the turn.
- **`has-store`** → a `components:` block and a built index already
  exist. This is a **refresh**, not a first backfill — skip Step 1's
  detect (the config is already there) and go straight to Step 3 (walk
  for newly-added un-headered files). Surface: "Component store already
  present — re-checking for un-headered components."
- **`backfill`** → the normal path. Continue to Step 1.

## Step 1 — detect + write the `components:` config

Run detection (LLM-driven + convention-agnostic — the same one adoption
uses; it reasons over the repo's structure rather than probing a fixed
list of conventional dir names, so any layout / monorepo tooling works):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" components detect
```

Read the stdout and branch:

- **"No recognizable component layout found"** → the model found no
  reusable UI components (e.g. a backend-only repo). Surface one line and
  end — there is nothing to backfill.
- **"already carries a components: block"** → fall through to Step 2.
- **"Wrote a components: block"** → the config now has a `components:`
  block. If the output also says **"Monorepo detected"**, run Step 1.5.
  Otherwise continue to Step 2.

### Step 1.5 — monorepo sharing (only when monorepo detected)

Every workspace is **isolated by default** — components in one workspace
are OFF-LIMITS to the others. A shared UI library workspace (e.g. a
`packages/ui` design system) should usually be `shared: true` so the
whole repo may use it. Detection never guesses this (isolation
invariant 3).

Read the workspace names from `.cairn/config.yaml` (`components.workspaces`).
Render an `AskUserQuestion` (multi-select) listing the workspaces:

> Which workspaces expose their components repo-wide (a shared UI/design
> library)? Leave all unchecked to keep every workspace isolated.

For each workspace the operator checks, add `shared: true` to that
workspace's block in `.cairn/config.yaml` (edit the file in place; touch
nothing else). If none are checked, leave the config as written.

## Step 2 — domain one-liner

For better `@purpose` / `@aliases`, gather a one-line domain summary the
annotators can ride on. Prefer `.cairn/ground/brand/` if it exists;
otherwise infer from the README's first paragraph. Keep it to one
sentence. This is optional context, not a gate.

## Step 3 — walk for un-headered components

List the component files missing a `@cairn` header:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" components check 2>&1
```

Each `ERROR missing @cairn header: <file>` line names one un-headered
component file (repo-relative). Collect them into the corpus.

For each file, resolve its workspace + category taxonomy by matching the
file path against `components.workspaces[*].componentDirs` (or the
top-level `componentDirs` for single-app) in `.cairn/config.yaml`, then
reading that workspace's `categories` (falling back to the top-level
`categories`).

If the corpus is empty (no missing headers — e.g. a refresh with nothing
new), skip to Step 5.

Surface a banner:

```markdown
---
**Component backfill** — N component files need a `@cairn` registry header.
Dispatching `component-annotator` subagents in rounds of 4 to add them.
Plan-quota, no API billing.
```

## Step 4 — annotate (operator-gated, batched)

**This step mutates source files**, so it is gated on per-batch consent.
Group the corpus into batches of ~4. For each batch, render an
`AskUserQuestion`:

- `a` annotate this batch · `b` skip this batch · `c` stop annotating

On `a`, spawn one `component-annotator` subagent **per file in the
batch** (up to 4 `Task` calls in a single assistant message → they run
in parallel; await all before the next batch). Each brief MUST inline:

- `file` — absolute path to annotate.
- `export_name` — the file's detected export; the `@cairn` value MUST be
  the exact exported name (the agent re-checks and renames nothing).
- `categories` — the workspace's taxonomy; `@category` MUST be one of these.
- `project_domain` — the one-liner from Step 2 (omit if none).
- The header is the FIRST comment block in the file. `@aliases` ≥2
  concrete searchable nouns. `@purpose` one line. Add `@singleton` ONLY
  for app-shell parts the project intends to exist exactly once.
- Do NOT change any code outside the inserted header comment.

The agent definition lives at `agents/component-annotator.md`
(`Task(component-annotator)` is pre-approved in this skill's frontmatter).
It carries the full `@cairn` grammar + write-once-correct rules inline.
Read disk, not the return text, as the source of truth.

On `b`, skip the batch (those files stay as missing-header debt). On
`c`, stop dispatching and go to Step 5 — emit still indexes whatever
headers now exist and queues the rest as debt.

## Step 5 — build the store

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" components emit
```

This builds the derived index under `.cairn/ground/components/`, promotes
every `@singleton` header to a §INV ledger entry, and writes any
still-missing headers + advisory audit findings to a baseline file the
attention queue triages. Capture the printed counts (indexed, singletons
drafted, missing, audit findings, baseline path).

## Step 6 — verify

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" components check 2>&1
```

- Exit 0 → the store is clean; every component is headered.
- Still failing → note the count of remaining un-headered files as debt
  the operator can finish later (re-run this skill any time).

## Step 7 — summary + hand off to attention

Produce a **single assistant turn** containing BOTH a summary AND, when
the emit step wrote a baseline (singleton §INVs to triage, audit
findings, or missing-header debt), a `Skill(cairn:cairn-attention)` call
to drain it. Do not end with text only when a baseline exists — that
orphans the findings.

Summary (tight, using the Step 5 counts):

- Components indexed.
- Singleton §INVs drafted (if any) — note they joined ground state as
  enforced invariants.
- Components still missing headers (if any) — re-run this skill to finish.
- Audit items to triage (if any).

If no baseline was written (everything headered, no singletons, no audit
findings), end with the summary alone — there is nothing to triage.
