---
type: rule
status: draft
audience: dual
generated: <seed_timestamp>
verified-at: <seed_timestamp>
source-commits:
  - manual
---

# Product positioning

<!--
WHAT THIS FILE IS

A tight statement of what the product is, who it's for, and
deliberately what it ISN'T. Injected at every SessionStart so the
agent stays inside-the-fence on feature suggestions and avoids
proposing work outside the product's intended scope.

WHEN TO FILL IT IN

Adoption pre-fills the body with the project's domain summary from
the mapper. Edit to add target audience + non-goals. Flip
`status: draft` → `status: accepted` once filled.

FORMAT

≤300 tokens. Cover four things:
  1. What it IS (one-sentence elevator pitch)
  2. Who it's FOR (target operator / user)
  3. Core value (the one job it does well)
  4. What's deliberately OUT of scope

Two examples to anchor on:

  Example A (fictional consumer service):
  > FoxGlove Florist hand-arranges seasonal bouquets for same-day
  > local delivery in the Pacific Northwest.
  > For: residential customers ordering for special occasions
  > (birthdays, sympathy, weddings).
  > Core value: locally-grown flowers, hand-tied arrangements,
  > deliveries within 4 hours of order.
  > Out of scope: nationwide shipping, corporate event florals,
  > artificial / silk arrangements, plant subscriptions.

  Example B (fictional B2B SaaS):
  > Northstar is a developer-facing observability tool that
  > traces queue depth + worker latency across BullMQ + Sidekiq
  > deployments.
  > For: backend engineers + SREs running async-job systems at
  > 1k–100k jobs/sec scale.
  > Core value: per-queue p99 latency dashboards + deadletter
  > replay without re-deploying.
  > Out of scope: log aggregation, APM tracing, alerting (use
  > PagerDuty), front-end RUM.
-->

(adoption auto-fill writes the project's domain summary here; edit to add audience + core value + out-of-scope)
