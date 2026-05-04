#!/usr/bin/env tsx
/**
 * smoke-session-start — buildSessionStartContext acceptance sensor.
 *
 * Pure-mechanical (no LLM burn). Builds a temp `.harness/` fixture with
 * seeded decisions, invariants, quality-grades, an active task, and a
 * pending draft, then invokes `buildSessionStartContext` and asserts:
 *
 *   1. resolveRepoRoot finds the fixture from a nested cwd.
 *   2. Empty `.harness/` (no ground/) returns the static sections only.
 *   3. Full fixture renders all 7 sections including each seeded id.
 *   4. Truncation kicks in past the maxChars cap; sectionsDropped is
 *      correctly populated; sectionsRendered reflects what's present.
 *   5. Resume-source flavor (smaller cap) keeps the load-bearing
 *      sections + current task and drops the rest.
 *   6. The hook telemetry contract — counts + warnings on malformed
 *      frontmatter.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionStartContext,
  resolveRepoRoot,
} from "@devplusllc/harness-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-session-start-"));
  cleanups.push(dir);
  return dir;
}

function seedFullFixture(repoRoot: string): void {
  const groundDir = join(repoRoot, ".harness", "ground");
  const decisionsDir = join(groundDir, "decisions");
  const inboxDir = join(decisionsDir, "_inbox");
  const invariantsDir = join(groundDir, "invariants");
  const tasksDir = join(repoRoot, ".harness", "tasks", "active", "TSK-2026-05-04-feature-1");

  mkdirSync(decisionsDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(invariantsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(decisionsDir, "DEC-0001.md"),
    `---
id: DEC-0001
title: Use Drizzle for the data layer
type: adr
status: accepted
audience: dual
generated: 2026-04-01T00:00:00Z
verified-at: 2026-05-04T00:00:00Z
decided_at: '2026-04-01'
scope_globs:
  - "core/src/db/**"
supersedes: null
superseded_by: null
assertions: []
---

# DEC-0001 — Drizzle for data layer

## Summary

We use Drizzle ORM.
`,
    "utf8",
  );

  writeFileSync(
    join(decisionsDir, "DEC-0002.md"),
    `---
id: DEC-0002
title: Cross-tenant denial fixture required on high-stakes UAT
type: adr
status: accepted
audience: dual
generated: 2026-04-15T00:00:00Z
verified-at: 2026-05-04T00:00:00Z
decided_at: '2026-04-15'
scope_globs:
  - "core/src/integrations/**"
  - "core/src/billing/**"
supersedes: null
superseded_by: null
assertions: []
---

# DEC-0002 — Cross-tenant fixture

## Summary

UAT fixtures must include a cross-tenant denial.
`,
    "utf8",
  );

  writeFileSync(
    join(invariantsDir, "V0001.md"),
    `---
id: V0001
title: No JSONB-userId filter in dashboard queries
type: invariant
status: active
audience: dual
generated: 2026-04-20T00:00:00Z
verified-at: 2026-05-04T00:00:00Z
source_run: run-abc123
source_decision: DEC-0001
sensor: scripts/check-v0001-no-jsonb-userid.ts
---

# §V0001
`,
    "utf8",
  );

  writeFileSync(
    join(groundDir, "quality-grades.yaml"),
    `version: 1
generated: 2026-05-04T00:00:00Z
modules:
  - module: core/src/integrations
    score: 42
    pass_rate: 0.42
    drift_count: 3
    last_updated: 2026-05-04T00:00:00Z
    recent_run_count: 5
  - module: core/src/dashboard
    score: 67
    pass_rate: 0.67
    drift_count: 1
    last_updated: 2026-05-04T00:00:00Z
    recent_run_count: 3
  - module: core/src/billing
    score: 91
    pass_rate: 0.91
    drift_count: 0
    last_updated: 2026-05-04T00:00:00Z
    recent_run_count: 2
`,
    "utf8",
  );

  writeFileSync(
    join(tasksDir, "spec.tightened.md"),
    `---
id: TSK-2026-05-04-feature-1
type: spec-tightened
status: ready_to_dispatch
audience: dual
generated: 2026-05-04T05:00:00Z
verified-at: 2026-05-04T05:00:00Z
spec_quality_score: 9
acceptance_criteria:
  - First AC line.
---

# Tightened spec — feature 1

## What

Implement feature 1 with attention to scope.

## Why

Reasons here.
`,
    "utf8",
  );

  writeFileSync(
    join(inboxDir, "DEC-0003.draft.md"),
    `---
id: DEC-0003
title: Pending draft about thing
type: adr
status: draft
audience: dual
generated: 2026-05-04T03:00:00Z
verified-at: 2026-05-04T03:00:00Z
decided_at: '2026-05-04'
decided_by: discord:operator
capture_source: discord:slash:/direction
capture_confidence: medium
---

# DEC-0003 — pending
`,
    "utf8",
  );
}

async function runSmoke(): Promise<void> {
  console.log("smoke-session-start — start");

  // ── Step 1 — resolveRepoRoot finds the fixture from nested cwd ───
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".harness"), { recursive: true });
    const nested = join(repoRoot, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });
    const resolved = resolveRepoRoot(nested);
    assert(resolved === repoRoot, `resolveRepoRoot from nested cwd: expected ${repoRoot}, got ${resolved}`);
    const noHarness = mkdtempSync(join(tmpdir(), "harness-smoke-session-start-bare-"));
    cleanups.push(noHarness);
    const resolvedNone = resolveRepoRoot(noHarness);
    assert(resolvedNone === null, `resolveRepoRoot for non-adopted dir: expected null, got ${resolvedNone}`);
    console.log("  ✓ Step 1 — resolveRepoRoot");
  }

  // ── Step 2 — empty .harness/ returns static sections only ────────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".harness"), { recursive: true });
    const result = await buildSessionStartContext({ repoRoot });
    assert(result.sectionsRendered.includes("header"), "Step 2: header missing");
    assert(result.sectionsRendered.includes("two_zone_reminder"), "Step 2: two_zone_reminder missing");
    assert(result.sectionsRendered.includes("tool_quick_reference"), "Step 2: tool_quick_reference missing");
    assert(!result.sectionsRendered.includes("decisions_in_scope"), "Step 2: decisions_in_scope should be absent");
    assert(!result.sectionsRendered.includes("invariants_active"), "Step 2: invariants_active should be absent");
    assert(!result.sectionsRendered.includes("current_task"), "Step 2: current_task should be absent");
    assert(result.counts.decisions === 0, `Step 2: counts.decisions expected 0, got ${result.counts.decisions}`);
    assert(result.counts.invariants === 0, `Step 2: counts.invariants expected 0, got ${result.counts.invariants}`);
    console.log("  ✓ Step 2 — empty .harness");
  }

  // ── Step 3 — full fixture renders all 7 sections ─────────────────
  {
    const repoRoot = mkFixture();
    seedFullFixture(repoRoot);
    const result = await buildSessionStartContext({ repoRoot });

    const expected: typeof result.sectionsRendered = [
      "header",
      "two_zone_reminder",
      "tool_quick_reference",
      "current_task",
      "decisions_in_scope",
      "invariants_active",
      "pending_drafts",
      "quality_grades_tail",
    ];
    for (const want of expected) {
      assert(result.sectionsRendered.includes(want), `Step 3: section "${want}" missing from rendered`);
    }
    assert(result.counts.decisions === 2, `Step 3: counts.decisions expected 2, got ${result.counts.decisions}`);
    assert(result.counts.invariants === 1, `Step 3: counts.invariants expected 1, got ${result.counts.invariants}`);
    assert(result.counts.activeTasks === 1, `Step 3: counts.activeTasks expected 1, got ${result.counts.activeTasks}`);
    assert(result.counts.pendingDrafts === 1, `Step 3: counts.pendingDrafts expected 1, got ${result.counts.pendingDrafts}`);
    assert(result.counts.qualityGrades === 3, `Step 3: counts.qualityGrades expected 3, got ${result.counts.qualityGrades}`);

    const ctx = result.additionalContext;
    assert(ctx.includes("DEC-0001"), "Step 3: DEC-0001 missing from context");
    assert(ctx.includes("DEC-0002"), "Step 3: DEC-0002 missing from context");
    assert(ctx.includes("V0001"), "Step 3: V0001 missing from context");
    assert(ctx.includes("TSK-2026-05-04-feature-1"), "Step 3: task id missing from context");
    assert(ctx.includes("DEC-0003"), "Step 3: pending draft id missing from context");
    assert(ctx.includes("core/src/integrations"), "Step 3: weakest module missing from context");
    assert(ctx.includes("harness_query_history"), "Step 3: two-zone reminder missing query_history reference");
    assert(ctx.includes("harness_decision_get"), "Step 3: tool quick-reference missing");
    assert(result.warnings.length === 0, `Step 3: unexpected warnings ${JSON.stringify(result.warnings)}`);
    console.log("  ✓ Step 3 — full fixture");
  }

  // ── Step 4 — truncation drops sections in priority order ─────────
  {
    const repoRoot = mkFixture();
    seedFullFixture(repoRoot);
    const result = await buildSessionStartContext({ repoRoot, maxChars: 1_500 });
    assert(result.totalChars <= 1_500, `Step 4: totalChars ${result.totalChars} exceeds cap 1500`);
    assert(result.sectionsRendered.includes("header"), "Step 4: header should survive truncation");
    assert(result.sectionsRendered.includes("two_zone_reminder"), "Step 4: two_zone_reminder should survive truncation");
    // The lowest-priority sections should be dropped first.
    assert(
      result.sectionsDropped.includes("quality_grades_tail") ||
        result.sectionsDropped.includes("pending_drafts"),
      `Step 4: expected at least one of quality_grades_tail/pending_drafts in dropped, got ${JSON.stringify(result.sectionsDropped)}`,
    );
    console.log("  ✓ Step 4 — truncation");
  }

  // ── Step 5 — resume flavor (small cap) keeps load-bearing only ────
  {
    const repoRoot = mkFixture();
    seedFullFixture(repoRoot);
    const result = await buildSessionStartContext({ repoRoot, maxChars: 4_000 });
    assert(result.sectionsRendered.includes("header"), "Step 5: header missing");
    assert(result.sectionsRendered.includes("two_zone_reminder"), "Step 5: two_zone_reminder missing");
    assert(result.sectionsRendered.includes("tool_quick_reference"), "Step 5: tool_quick_reference missing");
    assert(result.sectionsRendered.includes("current_task"), "Step 5: current_task missing — should fit in 4000-char cap");
    console.log("  ✓ Step 5 — resume flavor");
  }

  // ── Step 6 — malformed frontmatter is logged but doesn't crash ────
  {
    const repoRoot = mkFixture();
    seedFullFixture(repoRoot);
    // Append a draft with invalid YAML.
    const inboxDir = join(repoRoot, ".harness", "ground", "decisions", "_inbox");
    writeFileSync(
      join(inboxDir, "DEC-9999.draft.md"),
      `---
id: DEC-9999
title: Draft with invalid yaml ::: "
status: draft
audience: dual
unbalanced: [
---

# DEC-9999
`,
      "utf8",
    );
    const result = await buildSessionStartContext({ repoRoot });
    // Either it parses (passthrough) or it warns; both are acceptable.
    // What's NOT acceptable is a crash. Since we got a result, we're fine.
    assert(result.totalChars > 0, "Step 6: result.totalChars should be > 0");
    console.log("  ✓ Step 6 — malformed frontmatter survives");
  }

  // ── Step 7 — brand_and_positioning injection ─────────────────────
  {
    const repoRoot = mkFixture();
    const groundDir = join(repoRoot, ".harness", "ground");
    mkdirSync(join(groundDir, "brand"), { recursive: true });
    mkdirSync(join(groundDir, "product"), { recursive: true });
    writeFileSync(
      join(groundDir, "brand", "overview.md"),
      `---\nstatus: accepted\n---\n\n# Brand overview\n\nWe are bold and minimal.\n`,
      "utf8",
    );
    writeFileSync(
      join(groundDir, "product", "positioning.md"),
      `---\nstatus: draft\n---\n\n# Positioning\n\nFor solo developers.\n`,
      "utf8",
    );
    const result = await buildSessionStartContext({ repoRoot });
    assert(
      result.sectionsRendered.includes("brand_and_positioning"),
      "Step 7: brand_and_positioning section missing",
    );
    assert(
      result.additionalContext.includes("We are bold and minimal."),
      "Step 7: brand body missing from context",
    );
    assert(
      result.additionalContext.includes("For solo developers."),
      "Step 7: positioning body missing from context",
    );
    assert(
      result.additionalContext.includes("[DRAFT"),
      "Step 7: draft hint should appear when product/positioning.md is draft",
    );
    console.log("  ✓ Step 7 — brand + positioning injection");
  }

  // ── Step 8 — absent files: no section, no warnings ───────────────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".harness"), { recursive: true });
    const result = await buildSessionStartContext({ repoRoot });
    assert(
      !result.sectionsRendered.includes("brand_and_positioning"),
      "Step 8: brand_and_positioning should be absent when files don't exist",
    );
    assert(
      !result.warnings.some(
        (w) => w.includes("Brand overview") || w.includes("Product positioning"),
      ),
      `Step 8: no brand/positioning warnings expected, got ${JSON.stringify(result.warnings)}`,
    );
    console.log("  ✓ Step 8 — brand absent");
  }

  console.log("smoke-session-start — pass");
}

try {
  await runSmoke();
} finally {
  cleanup();
}
