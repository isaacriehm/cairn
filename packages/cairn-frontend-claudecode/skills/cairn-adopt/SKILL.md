---
name: cairn-adopt
description: One-time Cairn adoption pipeline for a new project.
when_to_use: |
  Use when operator opens Claude Code in project without `.cairn/`
  AND Cairn not declined. Drives one-time adoption inline via
  cairn_init_run MCP tool as state machine — each phase returns
  complete (advance) or needs_input (AskUserQuestion, thread answer,
  re-invoke). Skip when `.cairn/` exists or operator picked "never".
allowed-tools: Skill(cairn:cairn-attention), Task(curator-map), Task(curator-reduce), Task(component-annotator), Task(component-registrar)
---

# Skill: cairn-adopt

You are guiding the operator through one-time Cairn adoption for the
current project. Adoption is **visual, comprehensive, and one-time** —
once finished, Cairn runs invisibly forever. Refer to
`docs/PLUGIN_ARCHITECTURE.md` §6 for the canonical phase sequence.

## Step 0 — preload tools

Open the skill with **one** `ToolSearch` call that batch-loads every
deferred tool the loop needs. This avoids one round-trip per phase.
Use the **fully-qualified MCP tool names** (the bare `cairn_…` form
silently no-ops in `select:`). `AskUserQuestion` is built-in and stays
unprefixed.

```
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_init_resume,mcp__plugin_cairn_cairn__cairn_init_run,mcp__plugin_cairn_cairn__cairn_decision_get,mcp__plugin_cairn_cairn__cairn_resolve_attention,mcp__plugin_cairn_cairn__cairn_attention_dedup,AskUserQuestion)
```

After this single call all phase tools + the question tool + the
attention resolver are loaded for the rest of the skill.

## Trigger gate

Before doing anything else, classify the project's adoption state. There
are three buckets, NOT two — fresh, mid-adoption, and fully adopted —
because Phase 4-seed writes `.cairn/config.yaml` very early. A simple
`ls .cairn` check can't distinguish "operator quit during Phase 7" from
"adoption finished cleanly N sessions ago."

Run this single shell probe to classify. It is **ghost-aware**: a
ghost-adopted repo has no in-repo `.cairn/` — its state lives out-of-repo
at `~/.cairn/state/<root-commit>/`. The probe resolves the effective state
home (in-repo when present, else the out-of-repo ghost dir keyed on the
repo's root-commit) before classifying, so a previously-adopted ghost repo
is recognized as `adopted` / `mid-adoption` instead of re-triggering `fresh`
and re-prompting consent:

```bash
node -e '
  const fs=require("node:fs");
  const os=require("node:os");
  const path=require("node:path");
  const cp=require("node:child_process");
  const root=process.cwd();
  let home=path.join(root,".cairn");
  if(!fs.existsSync(home)){
    // No in-repo .cairn — this repo may be ghost-adopted. Ghost state lives
    // at ~/.cairn/state/<repo-id>; repo-id is the move-stable root-commit SHA
    // (matches registerGhostRepo). Resolve it and probe there instead.
    let rc="";
    try{rc=cp.execFileSync("git",["-C",root,"rev-list","--max-parents=0","HEAD"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim().split(/\s+/)[0]||"";}catch{}
    if(rc){const g=path.join(os.homedir(),".cairn","state",rc);if(fs.existsSync(g))home=g;}
  }
  const initState=path.join(home,"init-state.json");
  const config=path.join(home,"config.yaml");
  if(!fs.existsSync(home)){console.log("fresh");process.exit(0);}
  if(fs.existsSync(initState)){
    try{
      const s=JSON.parse(fs.readFileSync(initState,"utf8"));
      console.log("mid-adoption:"+(s.currentPhase||"unknown"));
    }catch{console.log("mid-adoption:unparseable");}
    process.exit(0);
  }
  if(fs.existsSync(config)){console.log("adopted");process.exit(0);}
  console.log("fresh");'
```

Branch on the output:

- **`fresh`** → check operator decline-state, then continue to Step 1
  (consent prompt). Decline check: `${CLAUDE_PLUGIN_DATA}/projects.json`
  → abort if `decline-never` is recorded for the current absolute repo
  path.
- **`mid-adoption:<phase>`** → adoption is in progress and was
  interrupted (operator `/exit`, crash, rate-limit bail, etc.). Consent
  was already granted. Skip Step 1 + Step 1.5, jump straight to Step 2
  (`cairn_init_resume`). Surface a one-line note like "Resuming Cairn
  adoption from `<phase>`." so the operator sees the pickup is
  intentional.
- **`adopted`** → fully adopted. Surface a one-line note ("Project
  already adopted — `/cairn:cairn-resume` or `/cairn:cairn-attention`
  for daily flow.") and exit.

If the probe errors entirely, fail closed by exiting with no output.

## Step 1 — propose adoption

Call `AskUserQuestion` directly with the three options:

- **`yes`** — walk adoption now (~30-60s, streamed)
- **`not now`** — ask again next session
- **`never for this project`** — mark opted-out

Do not preamble. Do not render the question as inline markdown — the
`AskUserQuestion` UI is the canonical render path.

- **`yes`** → continue to Step 1.5.
- **`not now`** → record `decline-temp` in `projects.json` (re-prompt
  after 7 days) and end the turn.
- **`never for this project`** → record `decline-never` in `projects.json`
  and end the turn.

## Step 1.5 — wire the statusline (one-time per machine)

The statusline is the only mid-turn render channel during the long
ingestion phases. Without it the operator stares at a frozen turn for
minutes during 7b-source-comments. Detect whether the user-level config
is already wired before asking; if it is, skip this step silently.

Detect — wired iff the command contains the runtime-glob marker:

```bash
node -e '
  const fs=require("node:fs");
  const os=require("node:os");
  const p=os.homedir()+"/.claude/settings.json";
  if(!fs.existsSync(p)){console.log("missing");process.exit(0);}
  try{
    const s=JSON.parse(fs.readFileSync(p,"utf8"));
    const c=(s.statusLine&&s.statusLine.command)||"";
    console.log(c.includes("plugins/cache/*/.active-version-path")?"wired":"unwired");
  }catch{console.log("unreadable");}'
```

- `wired` → skip to Step 2.
- `missing` / `unwired` / `unreadable` → render `AskUserQuestion`:

  > Cairn's statusline shows live progress during the long adoption
  > phases (especially 7b-source-comments, which is several minutes
  > on busy monorepos). Wire it into your user-level
  > `~/.claude/settings.json` now?

  - **`a) wire and reopen`** — patch settings now, ask the operator to
    `/exit` and reopen so this adoption has live progress
  - **`b) wire and continue`** — patch settings now, this adoption runs
    without live progress (next session sees it)
  - **`c) skip`** — leave settings alone; operator can run
    `/cairn:cairn-statusline-setup` later

On `a` or `b`, run the patch (same logic as `/cairn:cairn-statusline-setup`
Step 3 — re-implemented inline so the adopt loop doesn't depend on a
sibling slash command):

1. Verify the SessionStart shim exists at any plugin cache slug.
   The hook writes to `~/.claude/plugins/cache/<slug>/.active-version-path`
   where `<slug>` is whatever marketplace name Claude Code installed
   the plugin under — locate via a shell-free Node glob (works on
   Windows cmd/PowerShell too, where `ls`/`head` are absent):
   ```bash
   node -e "const f=require('node:fs'),{homedir}=require('node:os'),{join}=require('node:path');const C=join(homedir(),'.claude','plugins','cache');let s=null,t=-1;try{for(const x of f.readdirSync(C)){const p=join(C,x,'.active-version-path');try{const m=f.statSync(p).mtimeMs;if(m>t){t=m;s=p}}catch{}}}catch{}console.log(s||'')"
   ```
   On empty output, surface a one-line note ("statusline patch needs
   the plugin's SessionStart shim — re-run after the first session
   completes") and continue to Step 2 anyway.

2. Read `~/.claude/settings.json` (create with `{}` if missing). Use
   the `Edit` tool with the current file as `old_string` so other
   top-level fields stay intact. Set `statusLine` to the shell-free Node
   launcher below — one command for every platform (macOS, Linux, native
   Windows cmd/PowerShell), because Node performs the cache glob, mtime
   sort, file read, and re-spawn with no shell. It resolves the freshest
   `.active-version-path` shim, validates the path still exists, and
   falls back to globbing the newest `dist/cli.mjs` across cache version
   dirs if the shim dangles — so a slug rename or a deleted version dir
   self-heals. User-level `statusLine` cannot use `${CLAUDE_PLUGIN_ROOT}`
   (plugin-only var), so the launcher discovers the bundle itself; never
   hardcode a slug or version path:

   ```json
   {
     "type": "command",
     "command": "node -e \"const f=require('node:fs'),{homedir}=require('node:os'),{join}=require('node:path'),{spawnSync}=require('node:child_process');const C=join(homedir(),'.claude','plugins','cache');const newest=a=>{let b=null,t=-1;for(const p of a){try{const m=f.statSync(p).mtimeMs;if(m>t){t=m;b=p}}catch{}}return b};const slugs=()=>{try{return f.readdirSync(C).filter(s=>f.existsSync(join(C,s,'.active-version-path')))}catch{return[]}};let cli=null;const sh=newest(slugs().map(s=>join(C,s,'.active-version-path')));if(sh){try{const c=f.readFileSync(sh,'utf8').trim();if(c&&f.existsSync(c))cli=c}catch{}}if(!cli){const z=[];for(const s of slugs()){const pd=join(C,s,'cairn');let vs;try{vs=f.readdirSync(pd)}catch{continue}for(const v of vs){const p=join(pd,v,'dist','cli.mjs');if(f.existsSync(p))z.push(p)}}cli=newest(z)}if(cli)process.exit(spawnSync(process.execPath,[cli,'status-line'],{stdio:'inherit'}).status??0)\"",
     "refreshInterval": 10
   }
   ```

On `a) wire and reopen`, also surface:

> Statusline wired. `/exit` and reopen Claude Code in this project to
> activate it for the live progress indicator during adoption. Adoption
> resumes from `.cairn/init-state.json` after reopen.

End the turn — the operator restarts and the next session resumes
adoption with the statusline live.

On `b) wire and continue` or `c) skip`, fall through to Step 1.6.

## Step 1.6 — adoption mode (committed | ghost)

**Fresh adoptions only.** This step runs once, on the `fresh` branch,
**before** the pipeline writes its first byte. Skip it entirely on
`mid-adoption` / `adopted` — the mode was already chosen and recorded in
the global registry; re-asking would imply a mid-life mode flip, which is
not supported.

The choice is **never** auto-defaulted and **never** inferred from the
path. Ask it explicitly via `AskUserQuestion`:

- **`committed`** (the normal mode) — Cairn state lives in `.cairn/` inside
  this repo and is committed alongside your code. Teammates who clone the
  repo and run Cairn share the same ground state. CI can enforce it.
- **`ghost`** — private, local-only. **Nothing about Cairn touches this
  repo or its history**: no in-repo `.cairn/`, no `§DEC`/`§INV` source
  cites, no `@cairn` component headers, no edits to `CLAUDE.md`/`.gitignore`,
  no `.github/` CI workflow. State lives entirely outside the repo at
  `~/.cairn/state/`. Enforcement is advisory (the pre-commit sensor sweep
  warns, never blocks). For consultant / client work where the repo must
  stay byte-identical to un-adopted.

Render the one-line explanation as each option's `description`. Do not
preamble; the `AskUserQuestion` widget is the canonical render path.

Record the answer for Step 3:

- **`committed`** → the implicit default. The pipeline writes in-repo as
  today. Pass **no** `ghost` argument to `cairn_init_resume`.
- **`ghost`** → on the **first** `cairn_init_resume` call in Step 3, pass
  `{ ghost: true }`. That registers the repo as ghost in the global
  registry **before** any state is written, so the fresh init-state, the
  Phase 4 seed, and every later writer resolve to the out-of-repo home.
  Pass `ghost: true` only on that first call; subsequent `cairn_init_run`
  calls and any resume re-entry need no flag (the registry entry persists).

Fall through to Step 2.

## Step 2 — preflight

Run the deterministic preflight check:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || true
```

If the directory is not a git working tree, surface a one-line note +
`AskUserQuestion` (`init git repo` / `abort`). On `init git repo`,
run:

```bash
git init
git config --local safe.directory "$(pwd)"
git config --local core.fileMode false
```

The two `git config --local` calls are idempotent and silent if
already set. They prevent the WSL-from-Windows `dubious ownership`
error and avoid spurious mode-only diffs across cross-platform
clones. Cairn's Phase 1 detect re-applies them automatically when
WSL is detected (`process.platform === "linux"` AND `/proc/version`
matches `Microsoft|WSL`), so an operator who skips this step still
ends up with safe.directory + core.fileMode set. On `abort`, end
the turn.

The Claude binary is no longer required for adoption — the bundled
plugin includes everything cairn needs. Do not check for `claude`
on PATH.

## Step 3 — drive the phase pipeline

This is a state-machine loop against the `cairn_init_*` MCP tools.

**Contract (v0.3.5):** the phase tools persist `state` to
`.cairn/init-state.json` after every successful return and read it
back on the next call. You do **not** thread state through tool
arguments — phase tools take only an optional `answer` field for
needs_input phases. Tool responses are skinny: `{status, nextPhase}`,
`{status, question}`, or `{status, error}`. **Never** try to read the
on-disk state until the loop has terminated; until then the phase
tools own all writes to it.

**Init the pipeline** by calling `cairn_init_resume`. Pass **no args**
for committed mode (the default); pass `{ ghost: true }` on this first
call **only** when the operator chose `ghost` in Step 1.6 — that registers
the repo as ghost before any state is written, so the whole pipeline
resolves to the out-of-repo home. It returns `{ status: "ready" | "done",
nextPhase: <PhaseId> | null, repoRoot }`. If `status === "done"` the
project is already mid-init or fully adopted — abort and tell the operator
to check `.cairn/init-state.json`.

**Loop until done**:

```
while nextPhase != null:
    if nextPhase == "9b-curate":
        # Skill-driven pseudo-phase. Dispatch curator-map + curator-reduce
        # subagents to write .cairn/init/curator/final.jsonl, THEN call
        # cairn_init_run (which advances state once it sees the file).
        # See Step 3.5.
        run curator orchestration (Step 3.5)
    args = { "phase": nextPhase }
    result = call cairn_init_run(args)       # tool reads state from disk
    # v0.9.0: phases 8-docs-ingest and 10-rules-merge are no-op markers.
    # The unified curator pipeline (9a-walker → skill orchestration →
    # 9c-emit) replaces them. Both no-op runners stamp `skipped:
    # "merged-into-9-curator"` and advance the state machine.
    switch (result.status):
      case "needs_input":
        answer = AskUserQuestion(result.question.prompt, result.question.options)
        # Pass result.question.options.map(o => o.detail) as the
        # AskUserQuestion description field so the operator sees the
        # secondary hint inline with each choice.
        result = call cairn_init_run({ ...args, answer: answer.id })
        # second call returns "complete" | "error"; fall through.
      case "complete":
        nextPhase = result.nextPhase
        continue
      case "error":
        surface result.error.message + result.error.detail to operator
        ask via AskUserQuestion: `retry phase` / `abort`
        if "retry phase": continue (state on disk is intact — error path does NOT clobber)
        else: end turn
```

The phase tools persist `state` to `.cairn/init-state.json` after every
successful return so a mid-init `/exit` resumes cleanly on the next
session — the top of this loop just calls `cairn_init_resume` again.

**During each phase**, render a styled status banner BEFORE invoking
the tool. The banner is a markdown horizontal rule + bold phase name +
em-dashed description + scale-aware ETA + (for the long-running
phases) a one-line note explaining what is actually happening so the
operator isn't staring at a frozen turn for minutes wondering whether
adoption is alive.

Format:

```markdown
---
**Phase <id>** — <one-line description> · <eta>
<optional context line for long phases>
```

Use this exact phase registry — pick the matching row, substitute the
`<id>`, render. ETAs are ranges; tip the operator toward the high end
when `outputs["2-walker"].total_files > 300`. Do NOT improvise
descriptions:

| `<id>` | description | eta (small / large repo) |
|---|---|---|
| `1-detect` | environment + stack signature scan | <1s |
| `2-walker` | repo summary scan | <1s / ~2s |
| `3-mapper` | Sonnet domain map (per-module slice) | ~30-60s / 2-4min |
| `4-seed` | seed `.cairn/` skeleton + grandfather commits | <1s |
| `5-preflight` | count units + estimate ETA for long phases | <1s / ~3s |
| `6-brand` | brand auto-fill (Haiku) | operator + ~30s |
| `7-topic-index` | cross-source dedup pre-pass (Haiku judges semantically-similar pairs) | ~30s / 2-10min |
| `9a-walker` | unified curator corpus walk + regex pre-filter + shard pack | <5s |
| `9c-emit` | validate curator output + write DEC/INV ground files | <5s |
| `9d-comp-walk` | list component files missing a `@cairn` header | <5s |
| `9f-comp-emit` | build component index + draft singleton §INVs + audit | <5s |
| `11-baseline` | first sensor sweep | <1s / ~5s |
| `13-multidev` | per-host package manager hints | <1s |

`8-docs-ingest`, `9b-curate`, `9e-comp-annotate`, and `10-rules-merge`
are not listed. The docs/rules markers are v0.9.0 no-op markers (curator
pipeline subsumed both). `9b-curate` and `9e-comp-annotate` are
skill-driven pseudo-phases — Step 3.5 and Step 3.6 below handle their
surfaces (parallel subagent dispatch); skip the banner for both since
the dispatch is the surface.

For phases `3-mapper`, `7-topic-index`, `9a-walker`, and `9c-emit`,
render a one-line context note immediately under the banner so the
operator knows what's running. Pick the matching row; do NOT
improvise:

| `<id>` | context line |
|---|---|
| `3-mapper` | `Sonnet runs per detected module slice in parallel rounds of 4 (cap: 50 slices). Scales with module count.` |
| `7-topic-index` | `Walker collects markdown paragraphs; Haiku judges every cross-file pair above the Jaccard threshold (5-way parallel, hard cap 200). Watch the `⏳` indicator on your statusline for live `X/Y pairs (P%) ~Nm` updates.` |
| `9a-walker` | `Unified walker collects source comments + doc paragraphs + rule sections, drops 60-80% via regex pre-filter, packs into ≤120k-token shards. Deterministic, no LLM.` |
| `9c-emit` | `Validates curator output line-by-line and writes surviving entries directly to .cairn/ground/. Drops below the strict quality bar silently — counter logged.` |

**ETA banner — phase `5-preflight`**: when this phase completes, render
its `bannerLines` verbatim as a single block before invoking phase
`6-brand`. The pre-flight scan walks the source/doc/rule trees,
counts the units each long Haiku phase will process, and computes
`totalSeconds`/`totalSecondsHigh` against the per-machine calibration
cache at `~/.cairn/cache/eta-calibration.json`. Read the banner from
`.outputs["5-preflight"].bannerLines` and surface it so the operator
sees an honest pre-commit estimate before the long phases start.
After every long phase completes, the runtime folds the measured
`seconds / units` rate back into the cache via EWMA so subsequent
adoptions on this machine get a tighter estimate (self-corrects in
3-4 runs).

**Live progress**: phases `3-mapper`, `7-topic-index`, and `9a-walker`
write `.cairn/init/progress.json` after every batch / pair / module
processed. The Cairn statusline reads it and renders
`⬡ cairn ⏳ adopt <phase> X/Y (P%) ~Nm` in real time so the operator
isn't staring at a frozen turn for minutes. Step 1.5 wires this if it
isn't already. The `9b-curate` subagent dispatch in Step 3.5 surfaces
its own status — operator sees parallel subagent output in chat.

When the phase is operator-driven (`<eta>` = `operator`) the
`AskUserQuestion` widget appears immediately after the banner — do NOT
add a third "what would you like to do" line; the widget is the prompt.

**If the operator interrupts** (`/exit`, `Ctrl-C` mid-phase, or kills
the session): adoption is **safe to resume**. Phase state persists
to `.cairn/init-state.json` after every successful phase return.
The next session's SessionStart banner re-prompts via cairn-adopt;
the loop picks up at the same `currentPhase` via `cairn_init_resume`.
Surface this rule to the operator if they ask whether they can bail
on a long-running phase — they can.

**Do not render the phase's question inline** when a phase returns
`needs_input` — `AskUserQuestion` is the only render path;
double-rendering produces the question as scrollback text AND as an
interactive widget.

**Never spawn a subagent to drive the pipeline.** The skill itself is
the orchestrator. Spawning a generic-purpose Agent to run the loop
loses the operator-facing banner channel and burns tokens on a
nested ToolSearch + state re-discovery — adoption stays in this turn.
(Step 3.5 dispatches **typed** `curator-map` / `curator-reduce`
subagents for the 9b-curate pseudo-phase only; that is not the
pipeline driver, just one phase's parallel work.)

## Step 3.5 — curator orchestration (Phase 9b-curate)

When the loop hits `nextPhase === "9b-curate"`, run this orchestration
**before** invoking `cairn_init_run` for that phase. The MCP runner
for 9b-curate just confirms `final.jsonl` exists under the curator dir
+ counts entries; the actual map / reduce work happens here.

> **Path resolution (ghost-aware).** The `9a-walker` result returns an
> absolute `curator_dir`. In **committed** mode it equals
> `.cairn/init/curator`, so the repo-relative paths in the steps below work
> as-is. In **ghost** mode the repo has no in-repo `.cairn/` — `curator_dir`
> points out-of-repo under the state home. There, substitute `curator_dir`
> for every `.cairn/init/curator` path below, and give the `curator-map` /
> `curator-reduce` subagents ABSOLUTE paths under it. `9b-curate` validates
> `final.jsonl` at that absolute `curator_dir`; a repo-relative write lands in
> the client tree and fails `9b-curate-missing-final`.

Render a status banner before dispatch:

```markdown
---
**Phase 9b-curate** — synthesize ground state from corpus · ~1-3 min
Map: N parallel `curator-map` subagents (rounds of 4) over the shards
9a-walker packed. Reduce: 1 `curator-reduce` subagent over aggregated
candidates. Plan-quota Sonnet 4.6, no API billing.
```

### Step 3.5.1 — read the shard plan

```bash
cat .cairn/init/curator/shards.json
```

The file contains `{ shards: Shard[], total_input_tokens_estimate,
cap_per_shard }`. Each `Shard` has `shard_id`, `module`, and
`comment_ids`. If `shards` is empty (small repo or aggressive
pre-filter), skip 3.5.2 and write an empty `final.jsonl`, then jump
to 3.5.4 (advance via `cairn_init_run`).

### Step 3.5.2 — slice corpus into per-shard JSONL inputs

For each shard, write the shard's `CorpusRecord` lines to
`.cairn/init/curator/shards/<shard_id>.jsonl`. The corpus lives at
`.cairn/init/curator/corpus.jsonl` (one record per line). Use a
single Bash script (jq, awk, or node) that reads the corpus once and
filters per shard's `comment_ids` set — avoid one read-pass per
shard.

### Step 3.5.3 — dispatch `curator-map` subagents in parallel rounds of 4

For each shard:

1. Read the matching mapper `key_modules` row to source
   `module_summary` and `module_flags`.
2. Compose a Task brief that includes `shard_id`, absolute
   `shard_path`, absolute `candidates_path` (target:
   `.cairn/init/curator/candidates/<shard_id>.jsonl`), `module`,
   `module_summary`, `module_flags`, and `project_domain`.
3. Spawn the `curator-map` subagent via the `Task` tool. Send up to
   four briefs in a single assistant message so they execute in
   parallel; await all four before dispatching the next round.

Each subagent writes its candidates JSONL to disk and returns a
short summary. The skill reads disk; do not parse subagent return
text as the canonical output.

### Step 3.5.4 — dispatch `curator-reduce` subagent

Once every shard's `candidates/<shard_id>.jsonl` exists, spawn one
`curator-reduce` subagent. Its brief includes the
`candidates_glob`, the absolute `final_path`
(`.cairn/init/curator/final.jsonl`), `project_domain`, and the full
`key_modules` array.

The reducer is a single Sonnet call by default. If the aggregated
candidates exceed ~150k tokens (rare; usually only on >1k-shard
monorepos), the reducer's own brief tells it to run a
domain-bucket pre-reduce internally and produce one final output.

### Step 3.5.5 — advance the state machine

Call `cairn_init_run({ phase: "9b-curate" })`. The MCP runner reads
`final.jsonl`, counts entries, stamps `final_entries` into outputs,
advances to `9c-emit`. If the runner errors with
`9b-curate-missing-final`, the curator orchestration silently failed
to write `final.jsonl` — surface the error to the operator and ask
whether to `retry` or `abort`. Retries restart Step 3.5 from the top.

The next loop iteration runs `9c-emit`, which validates each entry
and writes ground state.

## Step 3.6 — component annotation (Phase 9e-comp-annotate)

When the loop hits `nextPhase === "9e-comp-annotate"`, run this
orchestration **before** invoking `cairn_init_run` for that phase. The
prior phase (`9d-comp-walk`) wrote the corpus of un-headered component
files; this step dispatches subagents that write `@cairn` headers into
those files. The MCP runner for `9e-comp-annotate` just counts how many
files now carry a header and advances — it never blocks, so annotation
is opportunistic (anything not headered here surfaces as missing-header
debt in the attention queue after adoption).

**Ghost mode — register, do NOT annotate.** If this adoption is ghost
(the operator picked `ghost` in Step 1.6, or the repo is registered
ghost), you MUST NOT dispatch the `component-annotator` — it writes
`@cairn` headers into client source, which ghost forbids (constraint 2).
Instead dispatch the **`component-registrar`** subagent: same
classification, but it calls `cairn_component_register` (out-of-repo, no
source edit) for each unit. Use the same per-batch consent + rounds-of-4
dispatch as Step 3.6.2, with these ghost differences:

- The banner says "registering" not "annotating", and notes that
  **nothing is written to source** — the classification lands in the
  out-of-repo registry.
- Spawn `component-registrar` (not `component-annotator`). Its brief
  inlines the same `file` / `export_name` / `workspace` / `categories`
  fields; it registers via the MCP tool and returns a one-line receipt.
- Anything the operator declines stays unregistered and surfaces as a
  soft `unregistered-unit` offer in the post-adoption attention queue.
- The `9e-comp-annotate` runner then counts `registered` /
  `still_unregistered` across the corpus (it never reads a header in
  ghost). Always advances.

**This whole step is OPTIONAL and gated on operator consent.** Writing
headers mutates source files. If the operator declines, skip straight
to Step 3.6.4 — the deterministic emit phase still indexes whatever
headers already exist and queues the rest as debt.

### Step 3.6.1 — read the corpus

```bash
cat .cairn/init/components/missing.jsonl 2>/dev/null
```

Each line is `{ file, workspace, export_name, categories }`. If the file
is absent or empty (no missing headers — e.g. a re-adoption), skip to
Step 3.6.4. Otherwise render a banner:

```markdown
---
**Phase 9e-comp-annotate** — annotate component headers · operator-gated
N component files are missing a `@cairn` registry header. Dispatching
`component-annotator` subagents (rounds of 4) to add them. Plan-quota,
no API billing.
```

### Step 3.6.2 — per-batch consent + dispatch

Group the corpus records into batches of ~4. For each batch, surface an
`AskUserQuestion` consent gate (like Phase 12's strip consent):

- `[a]` annotate this batch · `[b]` skip this batch · `[c]` stop annotating

On `[a]`, spawn one `component-annotator` subagent per file in the batch
(up to 4 in a single assistant message → parallel; await before the next
batch). Each brief MUST inline:

- `file` — absolute path to annotate.
- `export_name` — the detected export; the `@cairn` value MUST be the
  exact exported name (rename neither).
- `categories` — the workspace taxonomy; `@category` MUST be one of these.
- The header is the FIRST comment block in the file. `@aliases` ≥2
  concrete searchable nouns. `@purpose` one line. Add `@singleton` ONLY
  for app-shell parts the project intends to exist exactly once.
- Do NOT change any code outside the inserted header comment.

The subagent edits the file and returns a one-line receipt. Read disk,
not the return text, as the source of truth.

### Step 3.6.3 — `component-annotator` agent

The agent definition lives at `agents/component-annotator.md`
(`Task(component-annotator)` is pre-approved in this skill's
frontmatter). It carries the full `@cairn` grammar + the
write-once-correct rules (port invariant 8) inline so the requirements
ride the brief, not buried prose.

### Step 3.6.4 — advance the state machine

Call `cairn_init_run({ phase: "9e-comp-annotate" })`. The runner counts
`annotated` / `still_missing` (committed) or `registered` /
`still_unregistered` (ghost) across the corpus and advances to
`9f-comp-emit`, which builds the index, drafts singleton §INVs, and
queues any still-missing headers / unregistered units + audit findings to
the attention baseline. No error path — annotation/registration is
best-effort by design.

## Step 4 — auto-bootstrap the just-adopted clone

When the loop exits with `nextPhase === null`, the on-disk `.cairn/`
state is complete but `core.hooksPath` is still unset on this clone.
Run bootstrap silently — the operator just consented to adoption,
so there is no separate consent gate for the per-clone wiring:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" join
```

The `cairn join` step is idempotent; expected output is two-three
lines confirming hooks-path + chmod + `.cli-path`. Surface nothing
if it succeeds; on failure, surface the stderr + `AskUserQuestion`
(`retry bootstrap` / `skip`).

## Step 5 — final summary + hand off to attention

**This step is mandatory and produces a single assistant turn that
contains BOTH a summary text block AND a `Skill` tool call. Do NOT
end the turn with text only — the operator has not seen the pending
DEC drafts yet, and ending here orphans them in `_inbox/`.**

The phase tools persist final state to `.cairn/init-state.json` and
do **not** clear it on terminal completion. Read the persisted state
to source the summary fields:

```bash
node -e '
  const fs=require("node:fs");
  const s=JSON.parse(fs.readFileSync(".cairn/init-state.json","utf8"));
  const o=s.outputs||{};
  const g=(k)=>o[k]||{};
  console.log(JSON.stringify({
    curator_records:(g("9a-walker").records_total)||0,
    curator_shards:(g("9a-walker").shards)||0,
    curator_final:(g("9b-curate").final_entries)||0,
    decs_emitted:(g("9c-emit").decsWritten||[]).length,
    invs_emitted:(g("9c-emit").invsWritten||[]).length,
    curator_dropped:(g("9c-emit").dropped)||0,
    components_indexed:(g("9f-comp-emit").indexed)||0,
    components_missing:(g("9f-comp-emit").missing)||0,
    components_annotated:(g("9e-comp-annotate").annotated)||0,
    singletons_drafted:(g("9f-comp-emit").singletons_drafted)||0,
    component_audit:(g("9f-comp-emit").audit_findings)||0,
    baseline_findings:(g("11-baseline").totalFindings)||0,
    multidev_hosts:(g("13-multidev").hostKinds)||[]
  }));'
```

In the same assistant message, do both:

1. Emit a tight summary using the values above:

   - Decisions accepted into ground state (`decs_emitted`) — every
     entry already at `status: accepted`
   - Invariants seeded into ground state (`invs_emitted`) — every
     entry already at `status: active`
   - Curator drop count (`curator_dropped`) — entries the validators
     refused; surface only when > 0 so the operator knows the bar
     held
   - Components indexed (`components_indexed`) and singleton rules
     seeded (`singletons_drafted`) — surface only when
     `components_indexed > 0` (non-UI repos skip the component store).
     When `components_missing > 0` or `component_audit > 0`, note that
     N components still need `@cairn` headers / audit triage — the
     chained attention skill surfaces them for annotation.
   - Baseline sensor findings (`baseline_findings`)
   - Multi-dev install host kinds (`multidev_hosts`)

   Use plain operator-facing language. Do **not** say "§INV invariant
   proposals" or other internal-spec jargon — say "invariant rules
   seeded" or "hard constraints logged".

2. Immediately call the `Skill` tool with `skill: "cairn:cairn-attention"`
   to drain pending DEC drafts. The `allowed-tools` line in this skill's
   frontmatter pre-approves that single chained call. The cairn-attention
   skill renders DEC-a3f7b2c directly via `AskUserQuestion`; do not surface
   "Now reviewing the N pending DEC drafts…" prose — the next skill's
   prompt is the operator's next surface.

If you emit only the summary text and end the turn, adoption is
incomplete — the operator never gets the chance to accept/reject
drafts. The Skill call is the contract that adoption finished.

If a phase returned `error` and the operator chose `abort`, the state
file persists at `.cairn/init-state.json`; the next session's
SessionStart banner re-prompts to resume.

## Hard rules

- Never skip the trigger gate. A second-pass adoption on an already-
  adopted project corrupts ground state.
- Never write to `.cairn/ground/` from this skill. The phase tools
  own those writes (under the per-write flock).
- Never auto-resolve hard inconsistencies. Every conflict surfaces as
  AskUserQuestion; the operator picks.
- Comment-strip (Phase 12) requires per-module-batch consent. Default
  to surface, never silently strip.
- Never reference `npx ...`, `cairn <subcommand>`, or any CLI from
  the operator-facing chat output. Surface only AskUserQuestion
  prompts and one-line status updates.
- Never render an inline `[a]/[b]/[c]` blockquote for a question that
  also goes through `AskUserQuestion`. Pick one render path.
- Never thread `state` through phase tool arguments. Phase tools read
  state from `.cairn/init-state.json`; the only argument that flows
  back in is `answer` for needs_input phases.
- Never spawn a subagent to drive the pipeline loop. The skill is the
  orchestrator; nested agents lose the banner channel and burn tokens.
- Match the project's chat-reply voice from
  `.cairn/ground/brand/voice.md` when present (Cairn's spec-delta
  scan injects it into SessionStart context). Default to plain
  English when the file is absent or empty. Any code or document the
  skill writes is always full English regardless of voice.
