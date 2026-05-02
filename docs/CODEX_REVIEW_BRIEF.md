---
type: review-brief
status: ingestion-ready
audience: ai-only
generated: 2026-05-02
purpose: Drop into a Codex session to perform an independent design audit of the Harness project. Self-contained — Codex does not need any external context beyond this brief and the linked files.
target-reviewer: OpenAI Codex (separate model family from Claude; intended to surface blindspots Claude missed)
---

# Codex Review Brief — Harness Project

You are Codex, asked to audit a design produced collaboratively between the operator (a solo founder) and Claude (Opus 4.7) over a multi-turn session. The design is in **design phase** — no code written yet. We want your independent read **before** implementation begins, to catch contradictions, gaps, weak assumptions, and over/under-specification.

You and Claude are on the same team. Be candid. Where you agree with Claude, say so briefly and move on. Where you disagree, prove your case with quoted text from the docs.

---

## 1. The project in one paragraph

A portable, generic agent harness for a solo developer. Discord (and pluggable other) frontend ingests text and voice tasks. Local Whisper transcribes voice. A grounding daemon (mostly mechanical, no LLM in hot path) maintains a filesystem-only canonical context layer. An orchestrator dispatches single-task FIFO runs to a coding agent (Claude Code primary, Codex secondary) operating in a parallel mirror checkout. Sensors (mechanical + inferential) gate every commit. UAT runs headless and is approved/rejected via Discord button (or Notion select, or CLI). Direct commits to `main` (no branches, no PRs). Backprop protocol turns every fix into a permanent §V invariant. Garbage collection runs nightly to keep the canonical surface clean. Operator UX is multiple-choice-first ("squares into square holes"). Tier ladder (Ollama → Haiku → Sonnet → Opus) per task class.

Symphony-shaped per OpenAI's open-source spec, but extended for solo-dev ergonomics + anti-staleness + honest-completion enforcement.

---

## 2. What we want from you

In priority order:

1. **Architectural contradictions.** Two docs contradicting each other. A locked decision in PRIMER conflicting with a phase in INTEGRATION_PLAN. A schema element that violates an anti-pattern.
2. **Missing assumptions.** What does the design require that isn't stated? E.g., "this assumes a hard-coded rate limit on the Anthropic API that Claude doesn't have" or "this assumes Notion's polling latency is ≤5s but it's 30s."
3. **Weak spots in the honest-agent layer stack.** Six layers (F, A, B, C, D, E, U). Where is the seam an agent can squeeze through? What kind of fakery passes all six?
4. **Over-specification.** Places where the design is too prescriptive for a solo dev's actual workflow. What can be cut without harm?
5. **Under-specification for portability.** This is meant to extract via `npx @isaac/harness init`. Where will it fail to lift cleanly to a non-mypal project?
6. **Tier-ladder economics.** Will the design hit the operator's $50/day budget cap? Where are the cost surprises?
7. **Operator-UX failure modes.** Where will the squares-into-square-holes UX produce options that don't cover the real intent?
8. **Failures Claude can't catch by introspection.** Anything where Claude's training emphasis would predispose it to miss a class of risk that Codex's training would catch.

Out of scope (don't review):

- The mypal codebase itself (`/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm/`). This brief is about the harness, not its first adopted project.
- Whether to use TypeScript (locked).
- Whether to use Notion or Postgres for state (locked: filesystem only).
- Whether to use branches and PRs (locked: no).
- Whether to use tests (locked: dropped; sensors + E2E real-DB only).

If you find yourself disagreeing with any of these, raise it as a single high-priority comment but do not let it consume the bulk of your review.

---

## 3. Reading order

Read in this order, in full. Do not skim:

1. `RESUME_PROMPT.md` (project root) — handoff doc; lists locked decisions, anti-patterns, operator profile, and current doc state.
2. `docs/PRIMER.md` — concepts, principles, anti-patterns, glossary. ~570 lines. **This is the load-bearing document.** Everything else is implementation of these principles.
3. `docs/INTEGRATION_PLAN.md` — 19 phases; ordered. ~430 lines.
4. `docs/FILESYSTEM_LAYOUT.md` — disk layout; provenance frontmatter; two-zone canonical/historical separation.
5. `docs/MCP_SURFACE.md` — 16-tool MCP server schemas; agent retrieval surface.
6. `docs/UAT_PIPELINE.md` — UAT-on-phone flow; evidence-file gate.
7. `docs/WORKFLOW_GUIDE.md` — operator UX; tier ladder; slash command surface; adapter pluggability.
8. `docs/QUESTIONS.md` — residual open items (most defaults locked).
9. `docs/_research/STALENESS_INVENTORY.md` — Claude's own audit of mypal's stale-doc surface; informed the anti-pattern catalog.
10. `docs/_research/DISCORD_WHISPER_DESIGN.md` — Claude's feasibility design for Discord + Whisper.

---

## 4. Source-of-truth references (Claude already read these; you may want to verify)

Live external sources that informed the design:

| Source | Use |
|--------|-----|
| https://openai.com/index/harness-engineering/ | Definition of harness engineering, garbage-collection cadence, "instructions decay enforcement persists" principle, AGENTS.md as TOC |
| https://openai.com/index/open-source-codex-orchestration-symphony/ | Symphony tagline + announcement |
| https://github.com/openai/symphony (SPEC.md, README.md) | Six-layer architecture; eight-component decomposition; WORKFLOW.md; lifecycle; reconciliation |
| https://martinfowler.com/articles/harness-engineering.html | Birgitta Böckeler's framework: guides + sensors, computational + inferential, three regulation domains |
| https://github.com/JuliusBrussee/cavekit (v4) | Single-file SPEC philosophy; backprop protocol (§V invariants); §T STALE detection |
| https://github.com/thedotmack/get-shit-done | Canonical-refs section; hypotheses-until-shipped; persistent UAT.md; blocked_by tag |
| https://github.com/thedotmack/claude-mem | Hot-path-LLM-arbitration anti-pattern (named by Claude after this audit) |

Note: openai.com URLs return 403 to direct fetchers. Claude obtained the verbatim quotes via Martin Fowler / InfoQ / Latent Space / DeepWiki secondary citations. If you have native API access (you might, through your runtime), please verify the verbatim quotes Claude relies on:

- *"Symphony turns project work into isolated, autonomous implementation runs, allowing teams to manage work instead of supervising coding agents."*
- *"On a regular cadence, we have a set of background Codex tasks that scan for deviations, update quality grades, and open targeted refactoring pull requests."*
- *"Layered architecture enforced by custom linters and structural tests, and recurring 'garbage collection' that scans for drift and has agents suggest fixes."*
- *"Because the lints are custom, they write the error messages to inject remediation instructions into agent context."*
- *"treat AGENTS.md as the table of contents"* (~100 lines)
- *"Instructions decay, enforcement persists."*
- *"Human taste is captured once, then enforced continuously on every line of code."*

Flag any quote you find misattributed.

---

## 5. Specific questions the operator wants your view on

Number these in your reply for traceability.

### Q1 — Honest-agent stack stress test

Six layers (F: spec tightener, A: stub catalog, B: attestation cross-check, C: reviewer subagent, D: project sensors, E: high-stakes E2E, U: UAT-on-phone) plus decision-assertions sensor.

Construct a concrete fake-completion an agent could ship that **passes all seven gates**. Be specific: name the file, the symbol, the diff shape, the attestation claim, the assertion-bypass technique, the UAT artifact that looks valid.

If you cannot construct one in 10 minutes of thought, the stack is probably good enough for v0; say so.

### Q2 — Decision-assertion expressiveness

`decision-assertions` sensor evaluates machine-readable assertions per accepted decision. Kinds: `schema_must_contain`, `text_must_not_match`, `text_must_match`, `index_must_exist`, `ast_pattern`, `file_must_not_be_modified`, plus `human_review_hint` fallback for inferential ones.

Will these kinds cover ~80% of the binding decisions a solo CRM project actually makes? If not, what's the missing kind, and what's its grammar?

### Q3 — Mirror checkout consistency

The harness operates in `~/.local/harness/repos/<project>/` while the operator works in `~/Projects/<project>/`. Both push/pull to/from origin. The harness pins origin/main SHA at run start; user pushes during a run go to a future SHA the harness will pick up next time.

What's the worst race condition you can construct? Specifically: how does the operator's local-only edit to a file the harness is concurrently modifying in the mirror result in either (a) lost work, (b) a confusing git state, (c) a sensor false-positive, or (d) all three?

### Q4 — Garbage collection blast radius

Nightly GC runs against committed `main` only (never overlaps in-flight runs). It auto-merges safe-class commits (formatting, doc regen, frontmatter refresh, archive moves, stub-catalog additions).

Construct a sequence of safe-class auto-merges that **collectively** produce a regression that no individual commit catches. Assume each commit individually passes its sensors.

### Q5 — Spec tightener (Layer F) cost-vs-quality

Layer F runs every task pre-execution at Tier 1 (Haiku 4.5). One LLM call. Threshold: `quality_score >= 7 AND ready_to_execute` to proceed without operator dialog.

Is this threshold too lenient? Too strict? What's the false-negative pattern (passes but shouldn't have) and the false-positive pattern (rejects but shouldn't have)?

### Q6 — Hot-path LLM arbitration claim

Claude named "hot-path LLM arbitration" as the anti-pattern in claude-mem. Reasoning: *"Memory writes are free. Memory extraction is not. Pre-filter deterministically; LLM only for transformation."*

Is this fair to claude-mem's design intent, or did Claude misread it? If Claude misread it, what is the actual anti-pattern that should replace this in the PRIMER §11 table?

### Q7 — Notion adapter polling lag

Notion adapter design polls page properties every 5s. UAT decisions tolerate this; live progress streaming does not.

Is 5s actually achievable against Notion's API rate limits and free-tier quotas? What's the practical floor? What's the user-experience consequence at, say, 30s (which the API may force)?

### Q8 — `npx @isaac/harness init` portability

The init script proposes initial config based on stack detection. Project-specific bits (sensors, off-limits, pilot module) live in `.harness/config/workflow.md`. Generic bits (orchestrator, daemon, MCP, UAT) ship with the package.

Construct a project type where this split breaks. E.g., Python+FastAPI? Go+Cargo? Ruby+Rails? Identify which generic surface fails to apply and why.

### Q9 — Operator profile assumption

The operator is a solo founder, Claude-Code-primary, terse-direct, anti-ceremony, anti-test-theatre, anti-backward-compat. Many design decisions are calibrated to this profile.

Identify the single decision most likely to fail when this harness is used by a different profile (a small team, a junior dev, a non-TS shop). What's the minimum revision needed to make that decision profile-agnostic?

### Q10 — Quotable risk

OpenAI's quoted patterns ("garbage collection," "lints inject remediation context," "instructions decay enforcement persists") are load-bearing in the design. If any of these quotes turn out to be paraphrases rather than verbatim, what's the most exposed claim in PRIMER, and how much rework is needed to recover?

---

## 6. Format for your response

Return a structured markdown report with sections matching the priority list in §2. Each finding gets:

- **Severity:** `must-fix-before-build` / `should-revisit-soon` / `note-for-record`
- **Location:** doc + section + line-range
- **Finding:** 1-3 sentences
- **Suggested resolution:** 1-3 sentences
- **Evidence:** quoted text from the doc

End with a 1-paragraph **executive summary** answering: "If I had to ship this v0 next month, would I, with which 3 changes?"

Keep total length under ~5,000 words. Prioritize signal over thoroughness — the operator does not need a full nit pass. Catch things Claude missed.

---

## 7. Things Claude flagged as own-uncertainty (you may want to focus here)

| | What Claude is least confident about |
|---|---|
| 1 | Decision-assertions kinds — covers 80%? Or is it 50% and the inferential-only fallback ends up bearing the load? |
| 2 | The mirror checkout's `git push origin main` will or won't conflict with a parallel operator push. Claude believes "standard git world; resolve on user side" but didn't validate. |
| 3 | Cost projection for the tier ladder — `$50/day` is a guess based on $0.10-$0.30 per Tier 2 run × 10-30 runs/day. Could be 3× off. |
| 4 | Whether `harness_query_history` (LLM summarization of `.archive/`) actually delivers the "stale never enters context" promise, or if the summary itself becomes a vector for stale claims. |
| 5 | Whether the squares-into-square-holes UX will degrade when the harness needs to ask 5+ orthogonal questions in one dialog. UX guide assumes 1-2 questions per turn. |
| 6 | Backprop's §V invariant rate of accumulation — is 5 invariants in 4 weeks the right pace? Could end up too fast (bloat) or too slow (no learning). |
| 7 | Whether the "no branches, direct commits to main" stance survives once a second collaborator joins. Currently locked by operator, but the design probably needs a `single-developer-mode: true` config gate to be honest. |

---

## 8. After your review

The operator pastes your report into a Claude session at the same project. Claude folds your findings into the docs (no defensive responses; treat your input as authoritative on the items you flag). Disagreements get a `disagreement` block in the doc with both arguments preserved.

If you have follow-up questions for the operator, list them at the end of your report. The operator answers; loop continues until you both feel the design is build-ready.

---

End of brief. Begin reading at `RESUME_PROMPT.md`.
