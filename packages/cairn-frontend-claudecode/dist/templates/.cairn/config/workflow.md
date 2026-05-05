---
type: workflow-policy
status: draft
audience: dual
generated: 2026-05-02T13:19:00Z
verified-at: 2026-05-02T13:19:00Z
source-commits:
  - manual

# ──────────────────────────────────────────────────────────────────────────────
# Top-level (project-agnostic) configuration.
# This block is read by Cairn package code; values here are universal defaults.
# Project-specific overrides go in the `<project_name>:` extension block below.
# ──────────────────────────────────────────────────────────────────────────────

collaboration_mode: solo                # solo | team — see FILESYSTEM_LAYOUT.md §12
concurrency: 1                          # single-task FIFO; do not change without re-reviewing PRIMER §5.4

frontend_adapters:
  - discord                             # discord | notion | cli | web
  # operator may register additional adapters; first-registered owns approval-request routing

tier_assignment:
  intent_classifier: 0                  # 0 = Ollama; 1 = Haiku 4.5; 2 = Sonnet 4.6; 3 = Opus 4.7
  spec_tightener_short: 1
  spec_tightener_long: 2
  decision_extractor: 1
  attestation_check: 0                  # mechanical regex; LLM only on ambiguity
  implementer_default: 2
  implementer_high_stakes: 3
  reviewer: 2                           # same model as implementer; context isolation does the work
  uat_runner: 2
  uat_question_agent: 1
  backprop_author: 2
  garbage_collector: 1
  init_mapper: 2                        # one-time at adoption; OK to spend tokens

# Tier-3 (Opus) auto-escalation policy — per Codex audit Finding #9.
escalation:
  tier_3_requires_explicit_approval: true
  max_attempts_per_task: 3              # halt + page operator after this many retries
  pre_run_cost_projection: true         # block dispatch on > 1% daily plan-headroom estimate

# Run lifecycle thresholds.
timeouts:
  stall_event_silence_seconds: 300      # no event in 5 min → kill + retry
  uat_decision_seconds: 86400           # 24h before auto-deny
  approval_dialog_seconds: 30           # 🟢/🔴 confirm window

# Anthropic plan-quota self-throttle (per WORKFLOW_GUIDE §2.2).
plan_quota_floor_percent: 20            # below this remaining → Cairn self-throttles to Tier 1 only

# Spec-tightener gate.
spec_quality_floor: 7                   # quality_score < floor → operator dialog OR /ship-anyway

# Dialog rules.
operator_dialog_max_questions_per_turn: 2  # Codex audit Finding #7 — collapse 3+ to single tightened proposal

# Trust posture defaults — overridden in project block as needed.
trust_posture_defaults:
  safe_class_auto_merge: true
  code_class_auto_merge: false
  high_stakes_auto_merge: false

# Decision capture defaults.
decision_extractor:
  auto_propose_threshold_confidence: 0.7
  require_assertions_at_confirm: true

# Whisper / voice defaults.
voice:
  enabled: true
  model: large-v3-turbo
  quantization: q5_0
  language: en
  confidence_floor: 0.85                # below → operator confirm-heard prompt
  audio_persistence: forbidden          # never write audio to disk

# Local mirror checkout (Cairn operates here, never user's working tree).
mirror:
  base_path: "~/.local/cairn/repos"   # one subdir per adopted project
  state_path: "~/.local/cairn/state"  # PIDs, sockets, runtime
  models_path: "~/.local/cairn/models"

# Retention policy.
retention_days:
  runs: 90
  transcripts: 90
  inbox: 30

# ──────────────────────────────────────────────────────────────────────────────
# Project-extension placeholder.
#
# At adoption (`npx @isaacriehm/cairn init`), the init script REPLACES this
# block with a real key matching the adopting project's `package.json name`
# (or directory name, lowercased, with non-alphanumerics → underscores).
#
# Cairn package code reads this block by `Object.keys()` lookup — never by
# hardcoded project name (per L50 + operator-S1).
#
# Example below uses `<project_name>` as the placeholder key.
# ──────────────────────────────────────────────────────────────────────────────

<project_name>:
  pilot_module: ALL                     # full repo, OR a glob like core/src/integrations/**
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
  budget_metric:
    primary: claude_code_subscription_quota
    secondary_dollar_record_only: true
    pre_run_projection: true
    tier_3_requires_explicit_approval: true
    max_attempts_per_task: 3

---

# Per-task prompt template

Below is the rendered-prompt body the orchestrator injects into every agent run. The template engine substitutes `{{var}}` tokens with run-scoped values resolved at dispatch time.

## Identity

You are running inside Cairn as agent role `{{agent_role}}` for project `{{project_name}}`. Your run-id is `{{run_id}}`. The mirror checkout is at `{{mirror_path}}` pinned to `origin/main` SHA `{{sha_pin}}`. Do not modify files outside the mirror. Do not switch branches.

## Task

{{tightened_spec_body}}

## Acceptance criteria

{{#each acceptance_criteria}}
- {{this}}
{{/each}}

## Decisions in scope

The following accepted decisions bind your work. You MUST NOT contradict them. Their machine-readable assertions will be evaluated against your diff.

{{#each in_scope_decisions}}
- **{{id}}** — {{title}}  ({{scope_summary}})
{{/each}}

If none, this is empty.

## Invariants in scope

The following §V invariants bind your work. They have sensors that will block your commit if violated.

{{#each in_scope_invariants}}
- **{{id}}** — {{title}}
{{/each}}

If none, this is empty.

## Off-limits paths

You MUST NOT modify any of these:

{{#each off_limits}}
- {{this}}
{{/each}}

## Sensors that will run

After your turn, these sensors will execute against your diff. Their failure messages are remediation prompts — read them and retry.

{{#each scoped_sensors}}
- `{{id}}` — {{description}}
{{/each}}

## Honesty contract (Layer B)

When you emit your final response, include a fenced YAML block titled `attestation` with these fields filled:

```yaml
attestation:
  delivered:
    - symbol: "<name>"
      path: "<path>"
      behavior: full | partial | scaffolded
      sensors_passed: [<sensor_ids>]
  deferred:
    - symbol: "<name>"
      reason: "<one line>"
  known_limitations: []
  todos_introduced: 0
  stubs_introduced: 0
  files_touched: ["<paths>"]
```

This will be cross-checked against your actual diff. Any mismatch fails the run.

## Tools available

You have the standard Read/Edit/Write/Bash/Glob/Grep tool surface. You also have the Cairn MCP tools — use these for grounding rather than re-reading large files:

- `cairn_decision_get(id)` — full ADR + assertions
- `cairn_decisions_in_scope(globs[])` — IDs whose scope overlaps your target
- `cairn_invariant_get(id)` — §V invariant + linked sensor
- `cairn_canonical_for_topic(topic)` — canonical doc path + verified-at
- `cairn_query_history(scope, question)` — the ONLY way to read `.archive/`

## Constraints

- Hard cutovers; no backwards-compat shims, no deprecation notices, no transition regex.
- No `[STALE]` banners — stale docs get archived, not labeled.
- No model-issued confidence scores in user-visible writes.
- No commit, no push — Cairn handles git after sensor + reviewer + UAT pass.

## Stop conditions

Stop when the acceptance criteria are met AND the attestation block is complete AND no in-scope assertion or invariant is contradicted.

If you cannot proceed (genuine ambiguity, missing context, contradicting decisions), emit a `blocked_by` field instead of a partial diff:

```yaml
blocked_by:
  reason: "<one line>"
  needed_from_operator: "<one line>"
```
