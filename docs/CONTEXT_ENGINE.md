# Context Engine — server-driven orchestration

Status: **design locked, staged build in progress.** Stage 1 shipped; 2–4
pending. This doc is the source of truth; drift between it and the code is a bug.

## The problem

Every recurring Cairn pain traces to one root: **the LLM is the orchestrator.**
Cairn's control flow lives in prompts the model must follow perfectly and tools
it must remember to call, with the right args, at the right moment:

- it must know the `@cairn` header grammar to annotate a component
- it must classify a task as "UI work" to load the component registry
- it must re-run a ~15-tool `ToolSearch` + a 5-call context gather **every
  message** (the `cairn-direction` Step 0 + Step 1) — heavy, and repeated
- it must remember to annotate / capture / register at all

Each failure is "the LLM didn't drive Cairn perfectly." That is fragile and
context-expensive. The fix is not a better prompt — it is **moving orchestration
off the LLM and onto the server**, which is a persistent process sitting on the
scope-index, the ledgers, the bindings, and the file events.

## The principle — invert control

The LLM does two things: **write code** and **supply judgment when asked.**
The server does everything else. Every LLM interaction collapses to either:

1. **context it passively reads** (server-injected, scoped, deduped), or
2. **one fully-scoped, server-prompted action it cannot miss.**

Never "remember to call `X(Y)` at moment `Z`."

The server owns: what context the agent needs and when, what state-management is
outstanding, the mechanical half of every capture (header grammar, in-scope
resolution, validation). The agent owns only the irreducible semantic judgment
(name/purpose/category, decision rationale, spec intent).

## Mechanism — the hook surface (verified)

Claude Code hooks inject context via `hookSpecificOutput.additionalContext` and
may steer flow via `decision`/`continue`. Cairn already wires `SessionStart`,
`UserPromptSubmit`, `Stop`, `SessionEnd`, and `PostToolUse` (Read → read-enrich,
Write|Edit → post-write). **`PreToolUse` is intentionally never used — a failing
PreToolUse hook bricks the session.**

**Hard constraint — inject-only.** Cairn hooks emit `additionalContext` only.
They MUST NOT use `decision: "block"` or `continue: false`. A bug then degrades
to "no context injected," never "session trapped." Enforcement that must be hard
stays at the git pre-commit sensor sweep (a git hook — cannot brick the agent
loop) and `cairn doctor`. This honors the project's never-brick rule while still
inverting control.

| Hook | Role in the engine |
| ---- | ------------------ |
| `SessionStart` | Seed the full working bundle once: active task, mission/phase, in-scope counts, adoption/migration banners. (Exists.) |
| `UserPromptSubmit` | **The context engine.** Per prompt, inject the compact working header (active task + mission + in-scope ids), deduped against per-session state so unchanged context is never re-sent. The agent stops re-gathering. (Stage 1.) |
| `PostToolUse` (Read) / `PostToolBatch` | **The scope enricher.** As the agent navigates, attach the ground state bound to the files it just read — decisions, invariants, and the component slice for those paths. Pull → push. Deduped via a per-session "seen" set. (Stage 2 extends the existing read-enricher.) |
| `Stop` | **The capture gate.** At turn end (work done = peak understanding), list new/changed components missing a judgment field — mechanical fields (export, props, uses) pre-derived by the server — and surface one batched, fully-specified `cairn_component_annotate` ask. Inject-only; the pre-commit check is the hard backstop. (Stage 3.) |
| `PostCompact` | Re-inject the working bundle after compaction so context survives long sessions. (Stage 4, optional.) |

## Component annotation — semantics in, server writes

Header authoring splits by who holds the knowledge:

- **Agent (judgment, at peak understanding):** `category`, one-line `purpose`,
  `aliases`, which props are the public API. Supplied as fields to
  `cairn_component_annotate({ file, category, purpose, ... })` — never as header
  syntax. The agent never reads `workflow.md`'s grammar.
- **Server (mechanics + truth):** detect the export symbol, extract `@props`
  from the type, infer `@uses` from imports, **validate the agent's claims
  against the code** (category in the project enum, name matches the real
  export, declared props exist), format the canonical header, write it, rebuild
  the index + singleton §INV. Format is structurally impossible to get wrong;
  the registry cannot drift to a wrong name.

This is strictly better than a server-side classification LLM: the agent that
just wrote the component understands its *role in the feature* — a model seeing
the file cold cannot. Judgment stays in the main loop; only the grammar leaves.

## Staged rollout

Each stage independently reduces LLM reliance + context cost, ships green, and
is reversible.

1. **UserPromptSubmit working header (deduped).** Inject active task + mission +
   in-scope ids per prompt, only when changed. Removes the agent's need to call
   `cairn_in_scope` / `cairn_mission_get` to know its frame. ← **shipped**
2. **Scope enricher → components.** Extend the read-enricher / `PostToolBatch`
   to attach the component slice (and dedupe DEC/INV legends against a session
   "seen" set so navigation never re-bloats). Kills the "classify as UI work"
   trigger and the `components_in_scope` call.
3. **Stop capture-gate + `cairn_component_annotate`.** Server pre-derives
   mechanics, asks only for judgment, writes + validates the header.
4. **Shrink `cairn-direction`.** Once 1–2 make the gather redundant, the skill
   drops Step 0's ToolSearch + Step 1's gather and becomes the judgment core
   (pivot? mission? spec wording?) — cheap to re-enter per message.

## Risks + mitigations

- **Over-injection re-bloats context.** Every injector dedupes against
  per-session state — never re-send an unchanged header or an already-shown DEC.
  Without this the engine *becomes* the context problem.
- **Hook latency on hot paths.** Injectors are pure-FS + cached scope-index
  reads, zero LLM. The read-enricher already meets this bar.
- **Stop-gate loop.** A `Stop` that re-asks every turn traps the operator. The
  gate is inject-only (cannot force-continue) and debounced once-per-component
  per session (the stop-debounce infra exists).
- **Judgment quality.** The server may offer a non-LLM heuristic `category`
  prior (dir name, sibling components) for the agent to confirm/override —
  anchors without a server guess.
- **Ignorable nudges.** Inject-only nudges can be skipped; the pre-commit check
  remains the hard backstop. Defense in depth, not a single guarantee.
