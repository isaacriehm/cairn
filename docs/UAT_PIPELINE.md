---
type: uat-pipeline
status: needs-revision
audience: dual
generated: 2026-05-02
verified-at: 2026-05-03
depends-on:
  - PRIMER.md (§5 Layer U)
  - FILESYSTEM_LAYOUT.md (run artifacts)
  - MCP_SURFACE.md (evidence-file surface)
revision-note: Adapter-specific rendering sections (§5.2 Discord, §5.3 Notion) are stale — those are now frontend-adapter concerns. Core pipeline (§0–§4, §6) is current.
---

# UAT Pipeline — Click-button-confirm UX

The pipeline that runs after sensors + reviewer pass and before commit-and-push. Frontend-agnostic: outputs delivered through whatever operator console adapter is configured (Discord buttons, Notion select properties, CLI prompt, or web).

## 0. Goal

Solve "AI wants UAT but I'm out of the house." Operator approves or rejects from any device, any client, with a single tap or click. Evidence is mechanically validated (no fake-touch). Rejection routes structured feedback back to the agent for retry. No PR ceremony, no merge-button hunt — direct commit on 🟢.

## 1. When UAT runs

| Trust class | UAT runs? | Gate |
|-------------|-----------|------|
| Safe-class (formatting, doc regen, frontmatter refresh, archive moves, stub-catalog additions) | No | Sensors green → push directly |
| Code-class (touches `*.ts` outside generator-managed files) | Yes | Sensors + reviewer + UAT 🟢 → push |
| High-stakes (touches `core/src/{calls, deals, contacts, integrations, telephony}/**` or equivalent project-specific list) | Yes | Above + E2E real-DB + Layer E demo → push |

UAT only triggers after Layers A/B/C/D have passed. If an earlier layer fails, UAT is skipped and the run loops back to retry.

## 2. UAT-runner agent

Tier 2 (Sonnet 4.6 default; auto-escalate to Opus on second failure).

| Input | |
|-------|---|
| `task.spec.tightened.md` | What the operator actually wanted |
| Diff (from mirror) | What the agent did |
| Acceptance criteria (from spec.tightened.md) | Specific check items |
| Project-specific UAT hints (from `.harness/config/uat-hints.yaml`) | E.g., "test as user X", "use seeded DB", "reset Redis between runs" |

| Output | Path |
|--------|------|
| Playwright/curl/SQL script | `.harness/runs/active/<run-id>/uat/script.{ts,sh,sql}` |
| Recording (UI changes) | `.harness/runs/active/<run-id>/uat/recording.gif` |
| Screenshots at decision points | `.harness/runs/active/<run-id>/uat/screenshots/<n>.png` |
| Console log | `.harness/runs/active/<run-id>/uat/console.log` |
| Network log (UI changes) | `.harness/runs/active/<run-id>/uat/network.json` |
| For backend-only: request/response transcript | `.harness/runs/active/<run-id>/uat/api-transcript.md` |
| For backend-only: SQL diff | `.harness/runs/active/<run-id>/uat/sql-diff.md` |
| Pass/fail summary | `.harness/runs/active/<run-id>/uat/summary.yaml` |
| Evidence file | `.harness/runs/active/<run-id>/uat/.uat-passed` |

## 3. Three pipeline variants

### 3.1 UI-touching change

```
[diff applied to mirror]
   ↓
[harness boots local dev server in mirror — same `pnpm dev` the user runs]
   ↓
[UAT-runner generates Playwright script targeting the change]
   ↓
[script runs in headless Chrome via `mcp__claude-in-chrome` or local Playwright]
   ↓
[capture: GIF (animated), N screenshots, console log, network log]
   ↓
[script asserts: acceptance criteria checks; produces pass/fail per criterion]
   ↓
[evidence-file written: SHA256(bundle of GIF + screenshots + summary)]
   ↓
[bundle posted via active frontend adapter (Discord embed / Notion page / CLI)]
```

### 3.2 Backend-only change

```
[diff applied to mirror]
   ↓
[harness boots backend in mirror]
   ↓
[UAT-runner generates curl/grpc/sql script demonstrating the change]
   ↓
[script runs against local DB; before/after rows captured]
   ↓
[capture: request/response, SQL diff, structured event log if applicable]
   ↓
[script asserts: acceptance criteria; pass/fail per criterion]
   ↓
[evidence-file written: SHA256(transcript bundle)]
   ↓
[bundle posted via active frontend adapter — markdown table, no GIF]
```

### 3.3 Schema-or-migration change (cold-start smoke required)

Per GSD's pattern: when the diff touches startup files (`core/src/main.ts`, `migrations/`, `docker-compose.yml`, `core/db-extensions/`), automatically prepend a smoke step:

```
[smoke step]: pnpm db:reset && pnpm db:migrate && pnpm start:dev (boot for 30s)
   ↓ pass
[regular UAT pipeline 3.1 or 3.2]
```

Catches "schema migration breaks the world" cases that pass mechanical sensors.

## 4. Evidence-file gate (Layer that blocks fake completion)

After UAT runs, harness computes SHA256 of the bundle:

```
SHA256(concat(recording.gif, screenshots/*.png, console.log, network.json, summary.yaml))
```

Writes to `.harness/runs/active/<run-id>/uat/.uat-passed`:

```yaml
---
run_id: run-abc123
generated_at: 2026-05-02T05:38:00Z
bundle_sha256: <64 hex chars>
files:
  - recording.gif (sha256: ...)
  - screenshots/01.png (sha256: ...)
  - screenshots/02.png (sha256: ...)
  - console.log (sha256: ...)
  - network.json (sha256: ...)
  - summary.yaml (sha256: ...)
---
```

Pre-push gate refuses commit unless:

1. `.uat-passed` file exists in the run's UAT directory
2. The bundle hash, recomputed, matches what the file claims
3. Files referenced in the file all exist at the claimed paths
4. Operator approval has been recorded (`uat_decision: approve` in `summary.yaml`)

A bare `touch` of `.uat-passed` fails check 2 immediately. Modifying any artifact after the fact fails check 2. Agent cannot fake.

## 5. Operator surface — frontend-agnostic

The harness emits a **uniform UAT artifact bundle**. Each frontend adapter renders it appropriately.

### 5.1 Bundle structure (canonical, what adapters consume)

```yaml
# .harness/runs/active/<run-id>/uat/summary.yaml
---
run_id: run-abc123
task_id: TSK-2026-05-02-1
goal_one_liner: "Add unique partial index on integration_oauth_tokens(provider, user_id) WHERE archived_at IS NULL"
diff_stats:
  files_changed: 3
  lines_added: 17
  lines_removed: 0
artifacts:
  primary:
    kind: gif | api-transcript | sql-diff   # adapter renders accordingly
    path: recording.gif
  supporting:
    - kind: screenshot
      path: screenshots/01.png
      caption: "Before: no unique constraint"
    - kind: screenshot
      path: screenshots/02.png
      caption: "After: insert duplicate fails with 23505"
acceptance_criteria:
  - id: AC1
    text: "Migration produces valid SQL when applied to a fresh DB"
    status: pass
    evidence: "boot-log.txt:12-18"
  - id: AC2
    text: "Duplicate insert fails with unique-violation error"
    status: pass
    evidence: "screenshots/02.png"
  - id: AC3
    text: "Existing data unaffected by index addition"
    status: pass
    evidence: "sql-diff.md (rows: 0 modified)"
  # MANDATORY for high-stakes runs (per Codex audit Finding #5 — must-fix)
  - id: AC_CROSS_TENANT
    text: "Cross-tenant negative fixture: user/org B's request against user/org A's resource returns the expected denial (404/403/scoped-empty), AND duplicate insertion of (provider=stripe, user_id=B-user) succeeds independently of (provider=stripe, user_id=A-user) — proving scoping is enforced and not collapsed by an over-broad filter."
    status: pass
    evidence: "uat/cross-tenant-fixture.transcript.md"
    is_high_stakes_required: true
sensors_passed:
  - lint
  - tsc
  - schema-drift
  - decision-assertions (0 in scope)
reviewer_subagent_verdict: pass
operator_decision_required: true
operator_options:
  - id: approve
    label: "🟢 Approve & Push"
  - id: reject
    label: "🔴 Reject + tell me why"
  - id: ask
    label: "❓ Ask follow-up"
```

### 5.2 Discord adapter render

Posts to the run's channel (`task-add-oauth-unique-index` in `🟢 active` category):

```
🎬 UAT for run-abc123
Goal: Add unique partial index on integration_oauth_tokens(provider, user_id) WHERE archived_at IS NULL
Diff: 3 files, +17 / -0

[recording.gif embedded — autoplays in Discord]

Acceptance:
  ✓ AC1 — Migration produces valid SQL on fresh DB
  ✓ AC2 — Duplicate insert fails with 23505
  ✓ AC3 — Existing data unaffected

Sensors: lint, tsc, schema-drift  (all pass)
Reviewer: pass

[🟢 Approve & Push]  [🔴 Reject + tell me why]  [❓ Ask follow-up]
```

Discord Components V2 buttons. Operator taps from phone or desktop.

### 5.3 Notion adapter render

Posts to the run's Notion page (created in the configured tasks DB):

- Page title: `[run-abc123] Add unique partial index — UAT`
- Status property updated: `awaiting_uat_decision`
- Page body blocks:
  - `Goal: ...`
  - `Diff stats: ...`
  - GIF or first screenshot embedded as image block
  - Toggle: "All screenshots" containing remaining images
  - Table: acceptance criteria with status icons
  - Table: sensor passes
  - Reviewer verdict
- Decision: a Notion select property with options `🟢 Approve & Push`, `🔴 Reject`, `❓ Ask` — operator clicks the property to set it
- Notion adapter polls the property every 5s; reacts when it changes

### 5.4 CLI adapter render

For when operator is at the terminal:

```
$ harness uat watch
[run-abc123] Awaiting UAT decision
Goal: Add unique partial index ...
Open recording: file:///<path>/recording.gif

Acceptance:
  [✓] AC1 — Migration valid on fresh DB
  [✓] AC2 — Duplicate insert fails
  [✓] AC3 — Existing data unaffected

[A]pprove  [R]eject  [Q]uestion  >
```

### 5.5 Web adapter (future)

Same bundle, rendered as a thin Next.js page. Out of scope for v0.

## 6. Rejection flow

When operator chooses 🔴 Reject:

```
[adapter posts: "🔴 Rejected. What's wrong?
                  A) Feature missing entirely
                  B) UI/copy issue (specify in screenshot)
                  C) Wrong behavior (describe in voice/text)
                  D) Other"]
                ↓
[operator picks A/B/C/D + optional voice note or text]
                ↓
[harness writes rejection structured form to .harness/runs/active/<run-id>/uat/rejection.yaml]
                ↓
[harness re-spawns implementer subagent with rejection.yaml as context]
                ↓
[retry; new run-id; same task-id]
```

For voice rejection: Whisper transcribes; transcript appended to rejection.yaml.

```yaml
# rejection.yaml
---
run_id: run-abc123
rejected_at: 2026-05-02T05:42:00Z
category: B  # UI/copy issue
operator_note: |
  The success toast says "Created" but should say "Indexed".
  Also it disappears too fast — needs 4s instead of 2s.
voice_transcript: null
referenced_screenshots: [03.png]
---
```

Implementer's retry prompt is constructed by:

1. Original task spec.tightened.md
2. Original diff (so agent knows what it did)
3. UAT artifacts + summary.yaml
4. rejection.yaml
5. "Address the rejection. Do not regenerate from scratch unless category is A."

Agent ships a delta diff. New UAT round.

## 7. Question flow

When operator chooses ❓ Ask:

```
[adapter opens a thread / page block / CLI prompt]
                ↓
[operator types question or sends voice note]
                ↓
[Tier-1 agent reads run artifacts + question; answers in same surface]
                ↓
[operator can: approve, reject, or ask another question]
```

Question agent has read access to:

- `task.spec.tightened.md`
- The diff
- All UAT artifacts (recording, screenshots, console, network, sensor results)
- Reviewer subagent verdict + gaps
- Decisions ledger (in scope)

NOT: file write tools. NOT: ability to re-run sensors. Read-only Q&A.

## 8. Persistent UAT state across context resets

Per GSD's pattern: `.harness/tasks/<task-id>/uat.md` carries:

```yaml
---
type: uat
status: pending | passing | passed | failed | blocked | abandoned
generated: 2026-05-02T05:31:30Z
last_updated: 2026-05-02T05:42:00Z
attempt: 2
related_run_ids:
  - run-abc123
  - run-abc124
---

# UAT for TSK-2026-05-02-1

## Acceptance criteria
- [✓] AC1 — Migration produces valid SQL when applied to fresh DB
- [✓] AC2 — Duplicate insert fails with unique-violation error
- [✓] AC3 — Existing data unaffected by index addition

## Cold-start smoke (auto-injected)
- [✓] pnpm db:reset && pnpm db:migrate && pnpm start:dev boots without error

## Blocked-by (env issues, NEVER folded into Gaps)
(none)

## Gaps from prior rejections
- [resolved in run-abc124] Toast text "Created" → "Indexed"
- [resolved in run-abc124] Toast duration 2s → 4s

## Notes
Operator approved on attempt 2 at 2026-05-02T05:42:00Z.
```

Key invariant: **`blocked_by` items are NEVER folded into Gaps.** Environmental issues (server down, third-party API rate-limited, physical device required) are categorized separately. Treating them as code bugs triggers unnecessary fix-plan cycles.

## 9. Failure modes

| Mode | Response |
|------|----------|
| UAT-runner can't generate a script | Mark UAT as `failed-script-gen`; surface to operator with "manual UAT required" |
| Headless Chrome crash | Retry once; second fail → mark `failed-chrome-crash`; surface artifacts captured up to crash |
| Playwright assertion fails for a code-correctness reason | Pass/fail per AC; overall UAT fails; rejection.yaml auto-populated with failed AC list |
| Operator doesn't respond within timeout | Default `pending` for 24h; then `abandoned` with channel/page locked; operator can `/resume <run-id>` to revive |
| Evidence-file SHA mismatch | Hard reject push; `.uat-passed` content + recomputed hash both written to `failures.log` for debugging |
| Frontend adapter unreachable | Fall back to CLI adapter; queue the bundle for later post when adapter recovers |

## 10. Cost considerations

| Step | Tier | Approx cost |
|------|------|-------------|
| UAT-runner script generation | Tier 2 | ~$0.10 - $0.30 per run |
| Headless Chrome execution | Local | $0 |
| Playwright assertions | Local | $0 |
| Question-agent answer | Tier 1 | ~$0.02 per question |
| Whisper transcription of rejection voice | Local | $0 |

Auto-escalate UAT-runner to Tier 3 (Opus 4.7) when:

- High-stakes class
- Tier 2 failed twice in a row on this task
- Operator manually triggers `/eval --tier opus`

## 11. What the pipeline does NOT do

- Does not run the production system. Always against the mirror checkout.
- Does not push commits. That's the orchestrator's responsibility, gated on UAT 🟢.
- Does not modify the diff. UAT is read-only against the agent's output.
- Does not handle multi-step user flows beyond what the script can encode. Long ceremonial flows are spec smell — refactor the spec, not the pipeline.
- Does not block on operator forever. 24h soft timeout → abandoned state; can be revived.
- Does not store recordings beyond run retention (90 days; see FILESYSTEM_LAYOUT §retention).
