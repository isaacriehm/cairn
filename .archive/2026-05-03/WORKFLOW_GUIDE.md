---
type: workflow-guide
status: draft-v2
audience: dual
generated: 2026-05-02
depends-on:
  - PRIMER.md
  - INTEGRATION_PLAN.md
  - UAT_PIPELINE.md
---

# Workflow Guide — Operator UX, Adapter Pluggability, Tier Ladder, Slash Surface

How the harness presents itself to the human. Covers: frontend-adapter pluggability (Discord, Notion, CLI, web), the squares-into-square-holes UX rule, the tier ladder for model selection, the slash command surface, and concrete dialogue templates.

## 0. The frontend is pluggable

The orchestrator + grounding daemon + MCP server are **frontend-agnostic**. The operator console is a **swappable adapter** that consumes a uniform task/run/UAT artifact bundle and renders/listens via its native primitive.

| Adapter | Native primitive |
|---------|-------------------|
| `harness-frontend-discord` | Channels, threads, voice attachments, Components V2 buttons |
| `harness-frontend-notion` | Database rows, page bodies, select properties, comments |
| `harness-frontend-cli` | Terminal prompts, keyboard input |
| `harness-frontend-web` | Thin Next.js page (future) |

Reasoning: solo founder may use Discord. Their friend may use Notion. Other adopters may use CLI. The harness should not pick winners.

### 0.1 Adapter contract

Every adapter implements:

| Function | Purpose |
|----------|---------|
| `ingestTasks()` → `Task[]` | Pull operator-issued tasks (poll Notion DB, listen Discord events, read CLI prompts) |
| `ingestVoice()` → `VoiceMessage[]` | Pull voice notes if the surface supports them |
| `postTaskUpdate(taskId, status)` | Push run progress to the surface |
| `requestApproval(bundle)` → `Approval` | Display UAT bundle, wait for operator decision (with timeout) |
| `requestDialog(spec)` → `DialogResponse` | Display A/B/C/D options, return operator's pick |
| `notify(level, message)` | Out-of-band operator pings (errors, completions, paged events) |

Common types live in `harness/src/frontend/types.ts`. Each adapter is its own subdirectory: `harness/src/frontend/discord/`, `harness/src/frontend/notion/`, `harness/src/frontend/cli/`.

### 0.2 Multi-adapter mode

Operator can register multiple adapters simultaneously. Default routing:

| Event | Default adapter |
|-------|-----------------|
| Task ingest | Any registered |
| Run progress notifications | All registered (mirrored) |
| UAT approval request | First-registered (configurable) |
| Voice notes | Discord only (Notion+CLI don't natively support audio attachments) |
| Out-of-band errors | All registered |

Operator can override per-run with `/run --frontend notion` or equivalent.

## 1. Squares-into-square-holes — load-bearing UX rule

**The harness ALWAYS proposes A/B/C/D before asking for typed input.** Operator picks; harness does the structuring. Free-text only as escape (`E) Other / describe`). No CLI flag memorization. No regex typing.

### 1.0 Dialog question cap (per Codex audit Finding #7)

A single operator turn surfaces **at most 2 orthogonal questions**. If the spec tightener (or any other source) produces more than 2 ambiguities at once, the harness MUST collapse them: produce a single tightened-spec proposal that takes the most defensible default for each ambiguity AND surface ONE question to the operator: `[approve as drafted | edit | rewrite]`. Operator clicks `edit` to drill into specific ambiguities, OR `rewrite` to start from operator's own spec.

This prevents "ceremony by another name" — A/B/C/D dialogs that grow into 5+ orthogonal questions are functionally identical to a typed form.

### 1.1 Why

Operator profile: terse-direct, fast-intuitive, anti-ceremony. Multiple-choice respects all three. Typed input demands recall (which flag was it again?) and breaks flow. **The 2-question cap respects the operator's attention budget.**

### 1.2 When the rule applies

- Every operator decision the harness asks for
- Any agent escalation that needs operator input
- Resolution of any ambiguity surfaced by the spec tightener
- Any rejection-reason capture (UAT 🔴 path)
- Any "what should this be named / titled / summarized" prompt

### 1.3 When the rule does NOT apply

- Operator-initiated free-text task descriptions (`/task` slash + body)
- Voice notes (free-form by nature; transcribed and routed)
- Operator's own typed adjustments to drafted decisions ("edit this assertion")

### 1.4 Always include `E) Other` escape hatch

Reliability comes from the escape valve. If the harness's A/B/C/D options miss the operator's intent, `E) Other / describe` keeps the conversation going without forcing the operator to invent the right phrasing.

## 2. Tier ladder — model selection per task class

| Tier | Model | Use for | Auto-escalation rule |
|------|-------|---------|----------------------|
| **0** | Ollama `llama3.2:3b` (or `qwen2.5:3b`) — local | Intent classification, A/B/C menu construction, stub-pattern extraction from diff, "is this a decision?" first-pass, transcript word-snap-confirm | Confidence < 0.7 → escalate to Tier 1 |
| **1** | Haiku 4.5 | Spec-tightener (short tasks), decision-extractor structured output, run-attestation cross-check, cheap question-agent for UAT clarifications | Structured-output validation fail → escalate to Tier 2 |
| **2** | Sonnet 4.6 | Implementer (default), reviewer subagent, UAT-runner script generation, longer spec-tightener, backprop author | Sensor-fail twice on same diff → escalate to Tier 3 |
| **3** | Opus 4.7 | High-stakes implementer (mypal-specific gnarly modules), escalation when Tier 2 fails twice, operator-explicit `--tier opus` | Two consecutive fails → page operator |

### 2.1 Per-task-class assignment (`.harness/config/workflow.md` mypal: block)

```yaml
---
mypal:
  tier_assignment:
    intent_classifier: 0
    spec_tightener_short: 1
    spec_tightener_long: 2
    decision_extractor: 1
    attestation_check: 0  # mechanical regex; LLM only on ambiguity
    implementer_default: 2
    implementer_high_stakes: 3
    reviewer: 2  # same model as implementer; context isolation does the work
    uat_runner: 2
    uat_question_agent: 1
    backprop_author: 2
    garbage_collector: 1  # most GC is mechanical; LLM for inferential drift summaries
    init_mapper: 2  # one-time, OK to spend tokens
---
```

### 2.2 Cost discipline (per operator answer T1 + Codex audit Finding #9)

Operator uses Claude Code coding-plan subscriptions. **Raw $/day is not the budget metric — coding-plan quota / rate-limit headroom is.** Reformulated:

| Mechanism | What it does |
|-----------|-------------|
| **Pre-run cost projection** | Before Tier 2 dispatch, estimate token spend (input prompt size × tier rate × expected output) using a simple lookup. If projected cost > 1% of daily plan-headroom, surface to operator: "this run estimates X tokens / Y seconds; proceed?" |
| **Hard stop before Tier 3** | Tier 3 (Opus) auto-escalation requires explicit operator approval, EVERY time. No silent escalation. |
| **Per-task max attempts** | Default 3. After 3 retries (each potentially triggering tier escalation), task halts and pages operator. No infinite loops. |
| **Plan-quota monitor** | Anthropic API headers expose remaining-rate-limit info; harness reads, reflects in `/status`. When < 20% remaining, harness self-throttles to Tier 1 only until reset. |
| **Hard self-disable** | If 3 consecutive runs return rate-limit / overloaded errors, harness pauses dispatch and pages operator via active frontend adapter. |

Alarms-after-spend (post-hoc daily total) are too late; the harness blocks before incurring catastrophic spend. Dollar-tracking is still recorded (`.harness/staleness/log.jsonl`) for retrospective analysis but is not the primary gate.

### 2.3 Ollama install at adoption

`npx @devplusllc/harness init` checks `ollama list`. If missing or required models absent, prompts:

```
[A] Install Ollama + pull required models — recommended (~5 min, free, $0/day Tier 0)
[B] Skip — operate without Tier 0 (Tier 1+ for everything; ~$5-10/day extra)
[C] Re-check (I'll install in another terminal)
```

## 3. Slash command surface

Minimum surface, all backed by dialog. Adapter-specific bindings handle the actual command invocation (Discord slash, Notion comment-parser, CLI subcommand).

| Command | Purpose | Trust | Confirmation |
|---------|---------|-------|--------------|
| `/status` | Running task, queue depth, recent runs, cost-today, weakest module | Read-only | None |
| `/task` | Submit a new task; opens dialog | Write-creating | None |
| `/run <task-id>` | Dispatch a queued task | Write-creating | Reaction-confirm if outside pilot scope |
| `/halt [run-id]` | Kill active run | Write-creating | None |
| `/oops` | Conversational dialog: "what went wrong?" | Mixed | Inline reactions per step |
| `/direction <text>` | Capture user-issued direction change as candidate decision | Write-creating | 🟢-confirm before commit |
| `/eval [scope]` | Run sensors on demand | Read-only | None |
| `/ship-anyway` | Override spec-tightener gate or sensor false-positive | Override | None (logged) |
| `/agent <list \| reload>` | List subagents or reload definitions | Read-only | None |
| `/queue` | Show task FIFO queue | Read-only | None |
| `/resume <run-id>` | Revive an abandoned UAT run | Write-creating | None |
| `/archive <path>` | Quarantine a file | Write-creating | 🟢-confirm |
| `/help` | Surface this command list with examples | Read-only | None |

Everything else is dialog from a slash command or natural-language ingest.

## 4. Dialogue templates

### 4.1 `/oops` flow

```
You: /oops
Bot: Looking back at last 24h. What happened?
       A) Recent run produced wrong code (3 candidates)
       B) Doc became stale / contradicts current code
       C) Decision was missed / ignored by an agent
       D) Sensor false-positive / false-negative
       E) Something else (describe)
You: A
Bot: Which run?
       A) #142 — integrations OAuth refactor (12 min ago)
       B) #141 — dashboard role-check (2h ago)
       C) #138 — marketing template compile (yesterday)
       D) Show more
You: A
Bot: What's wrong with #142?
       A) Wrong direction — revert and redo
       B) Right idea, missed edge case (describe)
       C) Introduced a stub I want caught next time
       D) Conflicts with a decision I haven't recorded yet
       E) Other
You: C
Bot: Diff snippet shown.
     I extracted this candidate stub-pattern from the diff:
       Pattern: function body containing only `return null as any`
       in files matching: core/src/integrations/**/*.service.ts
     Add to stub-patterns.yaml so this is caught in future?
       🟢 yes
       🟡 modify the pattern (describe)
       🔴 no
You: 🟢
Bot: Added. Pattern committed. Re-running last sensor pass on run #142 to retroactively flag.
```

### 4.2 `/direction` flow (decision capture)

```
You: /direction we are killing the JSONB index thing, FK denorm only
Bot: Read as a binding decision change. Draft:
     ─────────────────────────────────────────────
       Title: FK denormalization replaces JSONB index pattern
       Scope: core/src/dashboard/**, core/src/proactive-actions/**
       Supersedes: DB-2-original
       Assertions I extracted:
         a1: schema_must_contain candidate_actions.actor_user_id
         a2: text_must_not_match "commandPayload->>'userId'" in scope
         a3: index_must_exist actor_user_id WHERE NOT NULL
     ─────────────────────────────────────────────
     Confirm decision?
       🟢 commit DEC-0042
       🟡 edit
       🔴 not a decision
You: 🟢
Bot: Committed. Ledger regenerated. All future runs see this.
     Sensors: decision-assertions sensor will evaluate a1-a3 against any diff in scope.
```

### 4.3 `/task` flow (with spec-tightener)

```
You: /task add unique partial index on integration_oauth_tokens for active tokens per provider
Bot: Drafting task. Running spec tightener (Haiku 4.5)...
     ─────────────────────────────────────────────
     Quality score: 7/10
     Ambiguities surfaced:
       Q1: What's the "active" condition?
            A) archived_at IS NULL
            B) deleted_at IS NULL
            C) status = 'active'
            D) Other (describe)
       Q2: Should the index include user_id, provider, or both?
            A) (provider, user_id)
            B) (user_id, provider)
            C) Just provider
            D) Both with reverse index too
     ─────────────────────────────────────────────
You: Q1: A, Q2: A
Bot: Tightened. Quality score: 9/10. Ready to dispatch.
     Pilot module: core/src/integrations
     Trust class: code (mid-stakes; sensors + reviewer + UAT required)
     Estimated cost: ~$0.40 - $1.20

     Dispatch now?
       🟢 yes
       🟡 edit spec further
       🔴 cancel
You: 🟢
Bot: Run dispatched. Task channel: task-add-oauth-unique-index (in 🟢 active)
     Run-id: run-abc123
     Will post UAT bundle when implementer + sensors + reviewer pass.
```

### 4.4 UAT decision (Discord)

```
[posted to task-add-oauth-unique-index thread]
🎬 UAT for run-abc123
Goal: Add unique partial index on integration_oauth_tokens(provider, user_id) WHERE archived_at IS NULL
Diff: 3 files, +17 / -0

[recording.gif embedded]

Acceptance:
  ✓ AC1 — Migration produces valid SQL on fresh DB
  ✓ AC2 — Duplicate insert fails with 23505
  ✓ AC3 — Existing data unaffected

Sensors: lint, tsc, schema-drift  (all pass)
Reviewer: pass

[🟢 Approve & Push]  [🔴 Reject + tell me why]  [❓ Ask follow-up]

You: 🟢

Bot: Pushed to main. Backprop running...
     New §V0042: "Unique partial index on integration_oauth_tokens(provider, user_id) WHERE archived_at IS NULL must exist."
     Sensor: harness/scripts/check-v0042-unique-oauth-index.ts
     Channel moved to 📦 archive.
```

### 4.5 UAT rejection (Discord)

```
You: 🔴

Bot: Rejected. What's wrong?
       A) Feature missing entirely
       B) UI/copy issue (specify in screenshot)
       C) Wrong behavior (describe in voice/text)
       D) Other
You: B
Bot: Drop a screenshot or describe in text/voice. Which screenshot?
       A) screenshots/01.png
       B) screenshots/02.png
       C) Take a fresh screenshot via /screenshot
       D) Describe without screenshot
You: B + voice note attached
[Whisper transcribes voice note]
Bot: Heard: "the success toast says Created but should say Indexed"
     Recorded as rejection.yaml. Re-spawning implementer with rejection context.
     New run: run-abc124. Same task.
```

## 5. Notion-adapter dialog equivalents

When Notion is the active frontend, dialogs are presented as Notion page blocks + select properties:

### 5.1 Task page on `/task`

The harness creates a Notion page in the configured tasks DB:

| Property | Value |
|----------|-------|
| Title | "Add unique partial index on integration_oauth_tokens" |
| Status | `tightening` |
| Trust class | `code` |
| Pilot module | `core/src/integrations` |
| Spec quality score | 7 |
| Decision | (empty until operator picks) |

Page body:

```
## Original spec
add unique partial index on integration_oauth_tokens for active tokens per provider

## Spec tightener output (Haiku 4.5)
Quality: 7/10
Ambiguities:
  Q1: What's the "active" condition?
    [☐ archived_at IS NULL]
    [☐ deleted_at IS NULL]
    [☐ status = 'active']
    [☐ Other (write below)]
  Q2: Field order?
    [☐ (provider, user_id)]
    [☐ (user_id, provider)]
    [☐ Just provider]
    [☐ Both with reverse index too]

## Operator answer
(write or check boxes here; harness adapter polls for changes)
```

The Notion adapter polls the page every 5s, parses checkbox/select state, advances the dialog when state changes. Notion-native; no plugin or webhook required.

### 5.2 UAT page on UAT-ready

A new page is created (or the run page updated):

| Property | Value |
|----------|-------|
| Status | `awaiting_uat_decision` |
| Decision (select: `🟢 Approve & Push` / `🔴 Reject` / `❓ Ask`) | (empty until operator picks) |

Page body has GIF embedded (image block), screenshots toggle, AC table, sensor table, reviewer verdict.

Operator clicks the Decision select → adapter polls, reacts within 5s.

### 5.3 What Notion can't do natively

- Voice notes — Notion doesn't render audio attachments inline. If the operator's primary frontend is Notion AND they want voice input, they post the voice note to a fallback Discord channel.
- Components V2 buttons — Notion has selects/checkboxes instead. Same UX, different primitive.
- Real-time push — Notion adapter polls. **Practical latency (per Codex audit Finding #10):** Notion's official rate limit averages ~3 req/s with variable burst behavior; webhooks aggregate updates and can take ~60s to fire. **The Notion adapter is appropriate for UAT decisions and status surfaces — not for live progress streaming.** Documented degraded-latency expectation: 30-120s for property-state propagation. Under 429 backoff conditions, the adapter falls back to a longer poll interval and surfaces a Discord-only fallback notification if a UAT decision is overdue.
- Polling discipline — adapter polls only the **one** active decision property, not arbitrary live-state. Backs off on 429 responses. Active progress streaming for the run lives in Discord (or CLI) only.

## 6. CLI adapter dialog equivalents

For when operator is at the terminal:

```
$ harness watch
[Tier 0 ready (Ollama)] [Tier 1-3 ready (Anthropic API)]

$ harness task "add unique partial index..."
Spec tightening (Haiku)... 

? What's the "active" condition?
  ❯ archived_at IS NULL
    deleted_at IS NULL
    status = 'active'
    Other (describe)
[arrow keys, enter to confirm]

? Field order?
  ❯ (provider, user_id)
    (user_id, provider)
    Just provider
    Both with reverse index too

Tightened spec ready. Quality: 9/10.
Dispatch now? [Y/n] Y
Run-id: run-abc123
$ harness watch run-abc123
[live progress streamed; tail-style]
```

## 7. Auto-merge policy detail

Per PRIMER §12.2 + INTEGRATION_PLAN §5 Phase 12:

| Class | Sensors | Reviewer | UAT | Push |
|-------|---------|----------|-----|------|
| **Safe** (formatting, doc regen, frontmatter refresh, archive moves, stub-catalog additions) | required | skipped | skipped | auto on green |
| **Code** (touches `*.ts` outside generator-managed files; not high-stakes) | required | required | required | on operator 🟢 |
| **High-stakes** (touches `core/src/{calls, deals, contacts, integrations, telephony}/**`) | required | required | required | UAT 🟢 + E2E real-DB pass + Layer E demo |

Operator override:

- `/ship-anyway` after a sensor fail → marks the failure as "operator-acknowledged false-positive"; sensor's `consecutive_false_positives` counter increments; auto-disables sensor at threshold 3 with operator paged
- `/auto-merge code-class` (configurable in workflow.md) → promotes code-class to safe-class behavior for a configurable scope-glob list; high-stakes never auto-merges

Operator promotes auto-merge classes carefully. Default: only safe-class auto-merges in v0.

## 8. Rejection-friction calibration

From operator's profile: **terse-direct, fast-intuitive**. Friction calibration:

| Action | Friction |
|--------|----------|
| Read-only commands | None |
| Routine task dispatch (pilot module, code-class) | None |
| Routine UAT approval | One tap (button/select) |
| Routine UAT rejection | A/B/C/D pick + optional note |
| Decision capture confirmation | One tap |
| Sensor override (`/ship-anyway`) | None (logged for audit) |
| Path archive | 🟢-confirm + reason in 1 line |
| Stub-pattern catalog addition (via `/oops`) | One tap (pattern auto-extracted) |
| Auto-merge class promotion | Operator types config block; deliberate friction |
| Sensor disable | Operator types config block; deliberate friction |
| Halt running task | Single command, no confirmation |

Pattern: read-only frictionless; write-creating one-tap; configuration-changing demands typing a block in the config file (high-friction by design — config changes are infrequent and consequential).

## 9. Operator-facing reply formatting

Bot replies follow a strict format:

```
[event line — emoji + headline]
[1-line context]

[the tables / lists / artifacts]

[footer: run-id (if applicable) + cost (if non-zero) + next-action]
```

Example:

```
🎬 UAT for run-abc123
Goal: Add unique partial index on integration_oauth_tokens

(GIF + AC table + sensors)

run-abc123 · cost $0.34 · waiting on your decision (24h timeout)
```

No emoji clutter. No multi-paragraph prose. Tables wherever 3+ attributes need showing.

## 10. Voice-note rules

| Rule | Why |
|------|-----|
| Voice notes only auto-pickup in Discord | Other adapters don't natively support audio |
| Audio never written to disk | PII risk; transcript-only |
| Confidence < 0.85 → bot asks "Heard: '...' — confirm?" | Prevents acting on misheard commands |
| Voice rejection on UAT → transcribed → folded into rejection.yaml | Same pipeline as text rejection |
| Voice on `/direction` → transcribed → fed to decision-extractor | Same pipeline as text direction |
| English only | Whisper supports more, but config locked to en for accuracy |

## 11. Operator preferences in `.harness/config/workflow.md`

**The harness package code is project-agnostic.** It reads the project-specific block by `Object.keys()` lookup at runtime — never by hardcoded project name (per operator answer S1: "the harness should propose sensors, agnostically, like dont mention 'mypal.' ANYWHERE within harness code, only internal docs"). The block key matches the adopting project's `package.json name` field (or directory name as fallback). Below shows the mypal-adopted shape; for any other project, replace `mypal:` with that project's name.

```yaml
# At top level — applies to harness regardless of adopted project
collaboration_mode: solo  # solo | team — see FILESYSTEM_LAYOUT.md §12

# Project-specific extension block — keyed by the adopting project's name
mypal:
  pilot_module: ALL  # per operator answer A2 — full repo, not single module
  off_limits:
    - core/RESUME_PROMPT.md
    - core/REVIEW_DECISIONS.md  # mypal-historical, leave alone
    - docs/decisions/
    - docs/design/brand/
  high_stakes_globs:
    - core/src/calls/**
    - core/src/deals/**
    - core/src/contacts/**
    - core/src/integrations/**
    - core/src/telephony/**
  trust_posture:
    safe_class_auto_merge: true
    code_class_auto_merge: false
    high_stakes_auto_merge: false
  frontend_adapters:
    - discord
    # operator can add 'notion' or 'cli' as additional registered adapters
  budget_metric:
    primary: claude_code_subscription_quota   # per operator answer T1
    secondary_dollar_record_only: true        # logged but not gated on
    pre_run_projection: true                  # per Codex Finding #9
    tier_3_requires_explicit_approval: true   # per Codex Finding #9
    max_attempts_per_task: 3                  # per Codex Finding #9
  retention_days:
    runs: 90
    transcripts: 90
    inbox: 30
  decision_extractor:
    auto_propose_threshold_confidence: 0.7
    require_assertions_at_confirm: true
```

The harness pkg has zero hardcoded `"mypal"` strings in source. Adopting a different project = change `mypal:` to `acme:` (or whatever the project name is) and update the values; harness reads by key lookup.

## 12. What this guide deliberately omits

- Implementation code — covered in `INTEGRATION_PLAN.md`
- MCP schema details — covered in `MCP_SURFACE.md`
- Filesystem layout — covered in `FILESYSTEM_LAYOUT.md`
- UAT pipeline mechanics — covered in `UAT_PIPELINE.md`
- Multi-tenant operator model — out of scope for v0; single-operator allowlist
- Web-UI adapter design — deferred until there's a second user
- Internationalization — English-only at launch
