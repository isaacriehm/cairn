#!/usr/bin/env tsx
/**
 * smoke-llm-prompt-eval — opt-in regression for the Phase 6 Stage-1
 * file-purpose filter prompt (PHASE_6_REDESIGN §4.1, §6).
 *
 * Burns real Haiku quota. NOT part of the standard 27-smoke gate. Run
 * this when:
 *   - touching the Stage-1 system prompt in
 *     packages/cairn-core/src/init/ingest-docs.ts (FILE_FILTER_SYSTEM)
 *   - upgrading the Haiku model alias used by runClaude
 *
 * Three inline fixtures (no disk fixtures, smoke is self-contained):
 *
 *   Fixture A — real ADR. Frontmatter + ## Decision/Context/
 *               Consequence headings. Expected is_authoritative: true.
 *   Fixture B — UAT log. Date-stamped heading, checklist majority.
 *               Expected is_authoritative: false.
 *   Fixture C — research scratchpad. Prose investigating multiple
 *               options, no committed decision. Expected
 *               is_authoritative: false.
 *
 * If Fixture B or C come back true, do NOT silently weaken assertions.
 * Either the prompt drifted (revisit PHASE_6_REDESIGN.md §4.1 wording)
 * or the model regressed — surface the failure to the operator.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runStage1FileFilter } from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function step(label: string): void {
  console.log(`── ${label}`);
}

const FIXTURE_A = `---
title: ADR-0042 — Sign JWTs with HS512
status: accepted
date: 2025-11-04
cairn:
  kind: decision
---

# ADR-0042 — Sign JWTs with HS512

## Decision

All authentication tokens MUST be signed with HS512. RS256 is forbidden
until a key-management surface is in place.

## Context

The deployment topology has no key-rotation infrastructure today. The
average request-latency budget is 50 ms and asymmetric verification
adds non-trivial CPU on the hot path. Symmetric HS512 keeps the auth
service fast and auditable; the 32-byte secret rotates via the same
deploy pipeline as the rest of the auth subsystem.

## Consequence

- Tokens older than 24 h MUST be rejected even if the signature is
  still valid (defense in depth).
- When KMS lands, this ADR is superseded by a follow-up ADR; do not
  silently introduce RS256 in the meantime.
`;

const FIXTURE_B = `# UAT log — Biller flow

## 2026-04-26 — UAT biller

Tester: Jamie. Build: 0.6.4-rc.3. Environment: staging-blue.

Pre-flight:

- [x] Stripe sandbox keys verified
- [x] Test merchant account "Acme-Test" provisioned
- [x] Webhook endpoint reachable from public sandbox

Steps:

1. [x] Log in as merchant operator
2. [x] Navigate to Billing → Invoices
3. [x] Create invoice for $42.13 (validates rounding)
4. [x] Confirm webhook fires within 30 s
5. [ ] Confirm receipt PDF renders (failed — see notes)

Notes:

- Step 5 failed: PDF rendered but the merchant logo was missing.
  Filed BUG-1287, assigned to @riley.
- Otherwise the flow looks correct end-to-end.
- Will re-run after BUG-1287 ships.

## 2026-04-25 — UAT biller (preceded run)

(Earlier session, kept for diff. Same shape, all checkboxes green.)
`;

const FIXTURE_C = `# 02.4-RESEARCH — Pricing engine survey

This is a research scratchpad. Nothing here is committed; the goal is
to map out the option space before we draft an ADR.

## Question

Should the new pricing engine round half-up or banker's-round at the
invoice line-item level? Current code is a mix; the billing service
rounds half-up, but the reporting service uses banker's-round when it
re-derives totals from raw line items, which has caused a handful of
penny mismatches.

## Options surveyed

### Option A — Half-up everywhere

Stripe and most legacy ERPs round half-up. Easy to explain to finance.
Slight statistical bias on aggregates; in practice the bias has been
negligible at our volume.

### Option B — Banker's-round everywhere

Mathematically unbiased on aggregates. Slightly harder to explain when
$0.005 lands on an even cent. A small fraction of European tax
authorities prefer this rounding mode.

### Option C — Per-line half-up, per-aggregate banker's-round

The hybrid we accidentally have today. Causes the penny mismatches.
Almost certainly the wrong long-term answer.

## Open threads

- [ ] Pull a week of invoices from prod and quantify the aggregate
      bias under A vs B.
- [ ] Talk to finance about reporting expectations.
- [ ] Survey what the handful of EU sub-tenants need before we lock
      this in.

This file is not authoritative. The ADR (when written) will live under
docs/adr/ and supersede this scratchpad.
`;

interface Fixture {
  path: string;
  body: string;
  expected: boolean;
  label: string;
}

async function main(): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), "cairn-smoke-llm-prompt-"));
  cleanups.push(repoRoot);

  const fixtures: Fixture[] = [
    {
      path: "docs/adr/0042-sign-jwts-with-hs512.md",
      body: FIXTURE_A,
      expected: true,
      label: "Fixture A — ADR",
    },
    {
      path: "ops/uat/2026-04-26-uat-biller.md",
      body: FIXTURE_B,
      expected: false,
      label: "Fixture B — UAT log",
    },
    {
      path: ".planning/02.4-RESEARCH.md",
      body: FIXTURE_C,
      expected: false,
      label: "Fixture C — research scratchpad",
    },
  ];

  for (const f of fixtures) {
    writeFile(repoRoot, f.path, f.body);
  }

  step(`Running Stage-1 file-purpose filter on ${fixtures.length} fixtures (real Haiku — burns quota)…`);
  const verdicts = await runStage1FileFilter({
    repoRoot,
    files: fixtures.map((f) => f.path),
  });

  let failed = 0;
  for (const f of fixtures) {
    const v = verdicts.get(f.path);
    if (v === undefined) {
      console.error(`✗ ${f.label}: no verdict returned for ${f.path}`);
      failed += 1;
      continue;
    }
    const ok = v.is_authoritative === f.expected;
    const tag = ok ? "✓" : "✗";
    const got = v.is_authoritative ? "true" : "false";
    const want = f.expected ? "true" : "false";
    console.log(
      `  ${tag} ${f.label}: is_authoritative=${got} (want ${want}) — reason: ${v.reason}`,
    );
    if (!ok) failed += 1;
  }

  if (failed > 0) {
    console.error(
      `\nsmoke-llm-prompt-eval — fail (${failed}/${fixtures.length} fixture${failed === 1 ? "" : "s"} mismatched)\n` +
        `\n  Stage-1 prompt is locked at PHASE_6_REDESIGN.md §4.1.\n` +
        `  Do NOT silently weaken the assertions to make this pass.\n` +
        `  If the model has regressed, surface the failure to the operator;\n` +
        `  if the prompt needs surgical revision, follow the round-3 Gemini\n` +
        `  re-vet protocol before changing it.\n`,
    );
    cleanup();
    process.exit(1);
  }

  cleanup();
  console.log("\nsmoke-llm-prompt-eval — pass");
}

main().catch((err) => {
  console.error("smoke-llm-prompt-eval — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
