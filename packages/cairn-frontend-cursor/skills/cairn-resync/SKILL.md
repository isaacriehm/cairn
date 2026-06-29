---
name: cairn-resync
description: Operator-initiated re-discovery — resolve config drift, re-cluster topics, re-curate grown areas into DEC/INV drafts.
when_to_use: |
  Use when the operator asks to "resync", "re-discover", "re-curate", or
  catch Cairn's ground state up to a grown/restructured tree — typically
  after the config-drift baseline nudge ("your project grew"). Three
  opt-in passes: deterministic config-resync, LLM topic re-cluster, and
  subagent re-curation of a new area into DEC/INV drafts. Skip during an
  active task, or when the operator only wants the one-tap config fix
  (that's `cairn_resync` direct, no skill needed).
allowed-tools: Skill(cairn:cairn-attention), Task(curator-map), Task(curator-reduce), Bash, Read
---

# Skill: cairn-resync

You are running Cairn's operator-initiated re-discovery so committed
ground state catches up to a tree that has grown or been restructured
since adoption.

Everything here is **opt-in, recoverable, and never auto-applies to
committed ground**: deterministic edits are `review`-class (the operator
commits the diff); LLM passes spend Haiku only on genuinely-new prose;
re-curation produces `_inbox/` drafts the operator drains. Confirm scope
with the operator before any pass that spends Haiku (re-cluster,
re-curate).

## Pass 1 — config-resync (deterministic, free)

Resolve the config-drift the sensor surfaced.

1. Preview: `cairn_resync({})` (dry-run default). Summarize the proposed
   `.cairn/config.yaml` edits — add a grown dir to `componentDirs`, add a
   new file type to `extensions`, add a `.gitignore` entry to
   `off_limits`, drop a dead `componentDir`, re-point a moved entity's
   `source_file`.
2. On the operator's OK: `cairn_resync({ apply: true })`. It archives the
   pre-resync `config.yaml` to `.cairn/ground/.archive/` and is
   idempotent. Tell the operator to review + commit the diff.
3. Pass `area` to scope either call to one subtree.

## Pass 2 — topic re-cluster (LLM, opt-in)

Offer this when prose has moved/grown enough that the topic-index is
stale. Confirm first — it spends Haiku (only on new prose; unchanged
pairs hit the cache).

1. Preview: `cairn_resync({ recluster: true })` — re-walks + judges and
   reports `topics_before → topics_after` + `judge_calls_fresh`, but
   overwrites no map.
2. On OK: `cairn_resync({ recluster: true, apply: true })` — archives the
   prior `topic-index.yaml` + `anchor-map.yaml`, then rebuilds them. The
   maps are gitignored, per-clone derived state, so there's nothing to
   commit.

## Pass 3 — re-curation of a new area (subagents, opt-in)

Re-run the curator over a grown area and surface the result as DEC/INV
drafts. **Always scope to an `area`** — a full re-curate is the adoption
pipeline's job, not this. Confirm the area + the Haiku spend first.

> **Ghost mode:** if the repo is registered ghost, the curator dir is
> out-of-repo. The `recurate:'walk'` response returns the absolute
> `curator_dir`; give the subagents absolute paths under it (mirror
> cairn-adopt Step 3.5's path-resolution note).

### 3.1 — walk the area

Call `cairn_resync({ recurate: "walk", area: "<dir>" })`. It builds the
curator corpus + shards scoped to that subtree and returns `shards_path`,
`curator_dir`, `records_total`, and `shards`. If `shards === 0`, there's
no curatable prose in the area — tell the operator and stop (skip emit).

### 3.2 — dispatch curator-map (parallel rounds of 4)

Read the shard plan with node (portable — never `cat`/`jq`):

```bash
node -e "console.log(require('node:fs').readFileSync(process.argv[1],'utf8'))" <shards_path>
```

For each shard, compose a `curator-map` Task brief with `shard_id`, the
absolute `shard_path` (`<curator_dir>/shards/<shard_file>`), the absolute
`candidates_path` (`<curator_dir>/candidates/<shard_id>.jsonl`), `module`,
and `project_domain`. (Post-adoption the mapper's `key_modules` summaries
may be gone — pass an empty `module_flags` and a short generic
`module_summary`; the curation degrades gracefully.) Send up to four
briefs per assistant message so they run in parallel; await each round
before the next. Subagents write JSONL to disk and return a short
summary — read disk, not the return text.

### 3.3 — dispatch curator-reduce

Once every `candidates/<shard_id>.jsonl` exists, spawn one
`curator-reduce` subagent with the `candidates_glob`, the absolute
`final_path` (`<curator_dir>/final.jsonl`), and `project_domain`. It
synthesizes the de-duplicated DEC/INV set into `final.jsonl`.

### 3.4 — emit drafts

Call `cairn_resync({ recurate: "emit" })`. It validates each `final.jsonl`
entry and writes it as a reviewable draft — DEC →
`.cairn/ground/decisions/_inbox/<id>.draft.md`, INV →
`.cairn/ground/invariants/_inbox/<id>.draft.md`, each `status: draft`. It
rebuilds no ledger and graduates nothing. Report the `dec_drafts` +
`inv_drafts` counts.

### 3.5 — hand off to cairn-attention

Invoke `Skill(cairn:cairn-attention)` so the operator drains the fresh
drafts inline: accept graduates a DEC to the ledger / an INV to active;
reject archives a `.rejected.md` tombstone; edit returns the body. Nothing
the curator proposed touches committed ground until the operator accepts.
