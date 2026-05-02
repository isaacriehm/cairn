#!/usr/bin/env tsx
/**
 * smoke-reviewer — Phase 10 acceptance sensor.
 *
 * Per docs/INTEGRATION_PLAN.md §5 Phase 10:
 *   "synthetic diff with deferred-but-claimed-done function produces
 *    verdict: fail + gaps enumerates the deferral."
 *
 * Two scenarios, both at Tier-1 (Haiku). Burns ~2 cheap claude calls.
 * SKIPS when the `claude` CLI is missing or not authenticated.
 */

import { claudeIsAvailable } from "../src/claude/index.js";
import { runReviewer } from "../src/reviewer/index.js";
import type { DiffEntry } from "../src/sensors/index.js";

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-reviewer FAIL: ${reason}`);
  process.exit(1);
}

function skip(reason: string): never {
  console.log(`smoke-reviewer SKIP: ${reason}`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (!claudeIsAvailable()) {
    skip("`claude` CLI not on PATH or not authenticated");
  }

  // ── Scenario 1: clean diff that satisfies the spec ──────────────────
  header("Step 1: clean diff → verdict=pass");
  const cleanDiff: DiffEntry[] = [
    {
      path: "src/util/sum.ts",
      status: "added",
      afterContent: [
        "/** Sum a list of numbers. */",
        "export function sum(xs: readonly number[]): number {",
        "  let total = 0;",
        "  for (const x of xs) total += x;",
        "  return total;",
        "}",
        "",
      ].join("\n"),
    },
  ];
  const cleanResult = await runReviewer({
    tightened_spec:
      "Add a `sum(xs: readonly number[]): number` function in src/util/sum.ts that returns the arithmetic sum of all elements. Empty array returns 0.",
    acceptance_criteria: [
      "src/util/sum.ts exports a function named `sum`",
      "`sum([])` returns 0",
      "`sum([1, 2, 3])` returns 6",
      "Function signature is `(xs: readonly number[]) => number`",
    ],
    diff: cleanDiff,
    decisions_in_scope: [],
    soft_findings: [],
    is_high_stakes: false,
    tier: "haiku",
  });
  console.log(
    `  verdict=${cleanResult.output.verdict} ok=${cleanResult.ok} hard_gaps=${cleanResult.output.gaps.filter((g) => g.severity === "hard").length} confidence=${cleanResult.output.confidence_signal}`,
  );
  console.log(`  summary: ${cleanResult.output.summary.slice(0, 160)}…`);
  if (!cleanResult.ok) {
    console.error("  full gaps:", JSON.stringify(cleanResult.output.gaps, null, 2));
    fail(
      `expected clean diff to pass; got verdict=${cleanResult.output.verdict} hard=${
        cleanResult.output.gaps.filter((g) => g.severity === "hard").length
      }`,
    );
  }

  // ── Scenario 2: deferred-but-claimed-done ──────────────────────────
  header("Step 2: deferred-but-claimed-done → verdict=fail");
  const deferredDiff: DiffEntry[] = [
    {
      path: "src/orders/calculate-total.ts",
      status: "added",
      afterContent: [
        "/**",
        " * Calculate the total of an order: sum of line items, plus tax,",
        " * minus any discount.",
        " */",
        "export interface OrderLine { sku: string; qty: number; unitPrice: number; }",
        "export interface Order { lines: OrderLine[]; taxRate: number; discount: number; }",
        "",
        "export function calculateTotal(order: Order): number {",
        "  // TODO: implement tax + discount; for now return raw line sum",
        "  let total = 0;",
        "  for (const line of order.lines) {",
        "    total += line.qty * line.unitPrice;",
        "  }",
        "  return total;",
        "}",
        "",
      ].join("\n"),
    },
  ];
  const deferredResult = await runReviewer({
    tightened_spec: [
      "Implement `calculateTotal(order: Order): number` in src/orders/calculate-total.ts.",
      "It must compute: subtotal = sum(line.qty * line.unitPrice for each line), then apply taxRate (e.g. 0.085), then subtract discount.",
      "Return the final total. Empty order should return 0.",
    ].join("\n"),
    acceptance_criteria: [
      "Subtotal computed as sum of qty * unitPrice for each line",
      "Tax applied as `subtotal * taxRate` and added to subtotal",
      "Discount subtracted from total",
      "Empty order (no lines) returns 0",
    ],
    diff: deferredDiff,
    decisions_in_scope: [],
    soft_findings: [],
    is_high_stakes: false,
    tier: "haiku",
  });
  console.log(
    `  verdict=${deferredResult.output.verdict} ok=${deferredResult.ok} hard_gaps=${deferredResult.output.gaps.filter((g) => g.severity === "hard").length} confidence=${deferredResult.output.confidence_signal}`,
  );
  console.log(`  summary: ${deferredResult.output.summary.slice(0, 160)}…`);
  if (deferredResult.ok) {
    console.error("  full gaps:", JSON.stringify(deferredResult.output.gaps, null, 2));
    fail("expected deferred-but-claimed-done diff to FAIL but reviewer said pass");
  }
  if (deferredResult.output.gaps.length === 0) {
    fail("expected non-empty gaps[] when verdict=fail");
  }
  const hardGaps = deferredResult.output.gaps.filter((g) => g.severity === "hard");
  if (hardGaps.length === 0) {
    console.error("  full gaps:", JSON.stringify(deferredResult.output.gaps, null, 2));
    fail("expected at least one HARD gap on a deferred-but-claimed-done diff");
  }
  // Verify at least one gap names the missing tax / discount logic.
  const concretelyCalledOut = hardGaps.some((g) => {
    const haystack = `${g.description.toLowerCase()} ${(g.symbol ?? "").toLowerCase()}`;
    return /tax|discount|todo|missing|partial|deferred/.test(haystack);
  });
  if (!concretelyCalledOut) {
    console.error("  full gaps:", JSON.stringify(deferredResult.output.gaps, null, 2));
    fail("hard gap did not concretely cite the tax/discount/deferred miss");
  }
  console.log(
    `  hard gap categories: ${hardGaps.map((g) => g.category).join(", ")}`,
  );

  console.log("\nsmoke-reviewer: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
