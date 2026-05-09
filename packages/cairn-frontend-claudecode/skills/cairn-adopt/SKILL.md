---
name: cairn-adopt
description: One-time Cairn adoption pipeline for a new project.
when_to_use: |
  Use when operator opens Claude Code in project without `.cairn/`
  AND Cairn not declined. Drives one-time adoption inline via
  cairn_init_run MCP tool as state machine — each phase returns
  complete (advance) or needs_input (AskUserQuestion, thread answer,
  re-invoke). Skip when `.cairn/` exists or operator picked "never".
allowed-tools: Skill(cairn:cairn-attention)
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
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_init_resume,mcp__plugin_cairn_cairn__cairn_init_run,mcp__plugin_cairn_cairn__cairn_decision_get,mcp__plugin_cairn_cairn__cairn_resolve_attention,mcp__plugin_cairn_cairn__cairn_bulk_accept_attention,mcp__plugin_cairn_cairn__cairn_attention_dedup,AskUserQuestion)
```

After this single call all phase tools + the question tool + the
attention resolver are loaded for the rest of the skill.

## Trigger gate

Before doing anything else, verify the trigger conditions:

1. The current project root has no `.cairn/` directory. Use the `Bash`
   tool with `ls .cairn 2>/dev/null` (or read the SessionStart context
   — if it included `cairn state` the project is already adopted and
   this skill must abort).
2. The operator has not previously declined adoption "forever" for this
   project. Check `${CLAUDE_PLUGIN_DATA}/projects.json` if present;
   abort if `decline-never` is recorded for the current absolute repo
   path.

If either gate fails, exit immediately with no output.

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
    `/cairn-statusline-setup` later

On `a` or `b`, run the patch (same logic as `/cairn-statusline-setup`
Step 3 — re-implemented inline so the adopt loop doesn't depend on a
sibling slash command):

1. Verify the SessionStart shim exists at any plugin cache slug.
   The hook writes to `~/.claude/plugins/cache/<slug>/.active-version-path`
   where `<slug>` is whatever marketplace name Claude Code installed
   the plugin under — locate via glob:
   ```bash
   ls -1t ~/.claude/plugins/cache/*/.active-version-path 2>/dev/null \
     | head -1
   ```
   On empty output, surface a one-line note ("statusline patch needs
   the plugin's SessionStart shim — re-run after the first session
   completes") and continue to Step 2 anyway.

2. Read `~/.claude/settings.json` (create with `{}` if missing). Use
   the `Edit` tool with the current file as `old_string` so other
   top-level fields stay intact. Set `statusLine` to the runtime-glob
   command shape so plugin slug renames don't break it:

   ```json
   {
     "type": "command",
     "command": "bash -c 'shim=$(ls -1t ~/.claude/plugins/cache/*/.active-version-path 2>/dev/null | head -1); [ -n \"$shim\" ] && node \"$(cat \"$shim\")\" status-line'",
     "refreshInterval": 30
   }
   ```

On `a) wire and reopen`, also surface:

> Statusline wired. `/exit` and reopen Claude Code in this project to
> activate it for the live progress indicator during adoption. Adoption
> resumes from `.cairn/init-state.json` after reopen.

End the turn — the operator restarts and the next session resumes
adoption with the statusline live.

On `b) wire and continue` or `c) skip`, fall through to Step 2.

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

**Init the pipeline** by calling `cairn_init_resume` (no args). It
returns `{ status: "ready" | "done", nextPhase: <PhaseId> | null,
repoRoot }`. If `status === "done"` the project is already mid-init or
fully adopted — abort and tell the operator to check
`.cairn/init-state.json`.

**Loop until done**:

```
while nextPhase != null:
    args = { "phase": nextPhase }
    result = call cairn_init_run(args)       # tool reads state from disk
    # Note: when nextPhase == "8-docs-ingest" the tool internally
    # fans out to phases 8 / 9 / 10 in parallel (shared DEC + INV id
    # Sets) and advances to "11-baseline". The skill does NOT need a
    # separate code path for the parallel runner.
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
| `5-pilot` | pick seed module | operator |
| `6-brand` | brand auto-fill (Haiku) | operator + ~30s |
| `7-topic-index` | cross-source dedup pre-pass (Haiku judges semantically-similar pairs) | ~30s / 2-10min |
| `8-docs-ingest` | Haiku ingest of README + docs/ → DEC drafts | ~15-30s / 1-3min |
| `9-source-comments` | Haiku classify essay-class JSDoc → DEC + invariant drafts | ~30s / **5-20min** |
| `10-rules-merge` | Haiku per H2 in CLAUDE.md / AGENTS.md / .claude/rules/* | ~30-90s / 1-3min |
| `11-baseline` | first sensor sweep | <1s / ~5s |
| `12-strip` | per-module strip-replace consent | operator |
| `13-multidev` | per-host package manager hints | <1s |

For phases `3-mapper`, `8-docs-ingest`, `9-source-comments`, and
`10-rules-merge`, render a one-line context note immediately under
the banner so the operator knows what's running. Pick the matching
row; do NOT improvise:

| `<id>` | context line |
|---|---|
| `3-mapper` | `Sonnet runs per detected module slice in parallel rounds of 4 (cap: 50 slices). Scales with module count.` |
| `7-topic-index` | `Walker collects markdown paragraphs; Haiku judges every cross-file pair above the Jaccard threshold (5-way parallel, hard cap 200). Watch the `⏳` indicator on your statusline for live `X/Y pairs (P%) ~Nm` updates.` |
| `8-docs-ingest` | `Haiku batch over README + docs/. Scales with doc file count and length.` |
| `9-source-comments` | `Haiku classifies every essay-class block comment in scoped source files (4-way parallel). On busy monorepos this is the longest phase — expect minutes, not seconds. /exit is safe; SessionStart resumes. Watch the `⏳` indicator on your statusline for live `phase X/Y (P%) ~Nm` updates.` |
| `10-rules-merge` | `Haiku per H2 section across CLAUDE.md / AGENTS.md / .claude/rules/*. Scales with section count.` |

**Live progress**: phases `3-mapper`, `7-topic-index`, `8-docs-ingest`,
`9-source-comments`, and `10-rules-merge` write
`.cairn/init/progress.json` after every batch / pair / module / doc /
section. The Cairn statusline reads it and renders
`⬡ cairn ⏳ adopt <phase> X/Y (P%) ~Nm` in real time so the operator
isn't staring at a frozen turn for minutes. Step 1.5 wires this if it
isn't already.

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
jq -c '{
  pilot: .outputs["5-pilot"].picked,
  decs_docs: (.outputs["8-docs-ingest"].decDraftsWritten // [] | length),
  decs_comments: (.outputs["9-source-comments"].decDraftsWritten // [] | length),
  decs_rules: (.outputs["10-rules-merge"].decDraftsWritten // [] | length),
  invariants: (.outputs["9-source-comments"].invariantsWritten // [] | length),
  baseline_findings: (.outputs["11-baseline"].totalFindings // 0),
  multidev_hosts: (.outputs["13-multidev"].hostKinds // [])
}' .cairn/init-state.json
```

In the same assistant message, do both:

1. Emit a tight summary using the values above:

   - Pilot module
   - DEC drafts proposed (sum of `decs_docs + decs_comments + decs_rules`)
   - Invariants seeded into ground state (each entry is a `INV-<NNNN>`
     file already at status `active`)
   - Baseline sensor findings
   - Multi-dev install (host kinds rolled up)

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
