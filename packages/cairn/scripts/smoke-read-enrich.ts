#!/usr/bin/env tsx
/**
 * smoke-read-enrich — citation-scanner + legend-builder + scope-index
 * integration. Pure-mechanical, no LLM burn, no stdin shaping (we test the
 * in-process building blocks directly).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLegend,
  getInvariantsLedger,
  getScopeIndexEntry,
  lookupTask,
  scanCitations,
  writeScopeIndex,
  type ScopeIndexHint,
} from "@isaacriehm/cairn-core";

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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-read-enrich-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-read-enrich — start");

  // ── Step 1 — scanCitations finds §INV / TODO / DEC ─────────────────
  {
    const sample = `// §INV-2323232 ground truth
const x = 1;
// TODO(TSK-foo) finish this
// §DEC-deadbee explicit route file
// DEC-deadbe1 prose ref (no §) — should NOT match
`;
    const matches = scanCitations(sample);
    assert(
      matches.invariants.length === 1 && matches.invariants[0]?.id === "INV-2323232",
      `Step 1: expected one §INV-2323232 match, got ${JSON.stringify(matches.invariants)}`,
    );
    assert(
      matches.todos.length === 1 && matches.todos[0]?.id === "TSK-foo",
      `Step 1: expected one TSK-foo match, got ${JSON.stringify(matches.todos)}`,
    );
    assert(
      matches.decisions.length === 1 && matches.decisions[0]?.id === "DEC-deadbee",
      `Step 1: expected one §DEC-deadbee match, got ${JSON.stringify(matches.decisions)}`,
    );
    console.log("  ✓ Step 1 — scanCitations (DEC requires § prefix)");
  }

  // ── Step 2 — empty content → buildLegend returns null ────────────
  {
    const empty = scanCitations("");
    const result = buildLegend(empty, null, null, null, () => ({ found: "not_found" }));
    assert(result === null, `Step 2: expected null on empty input, got ${String(result)}`);
    console.log("  ✓ Step 2 — empty content → null legend");
  }

  // ── Step 3 — non-empty citations produce a legend block ──────────
  {
    const matches = scanCitations("// §INV-2323232 something");
    const result = buildLegend(matches, null, null, null, () => ({ found: "not_found" }));
    assert(result !== null, "Step 3: expected non-null legend");
    if (result === null) return;
    assert(
      result.includes("§INV-2323232"),
      `Step 3: expected §INV-2323232 in legend, got ${result}`,
    );
    console.log("  ✓ Step 3 — citation legend");
  }

  // ── Step 4 — scope-index integration via getScopeIndexEntry ──────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });
    writeScopeIndex(repoRoot, {
      generated: "2026-05-04T03:00:00Z",
      files: {
        "src/auth/login.ts": {
          decisions: ["DEC-deadbee"],
          invariants: ["INV-4141414"],
        },
      },
    });

    const hit = getScopeIndexEntry(repoRoot, "src/auth/login.ts");
    assert(hit !== null, "Step 4: scope-index hit should be non-null");
    if (hit === null) return;
    assert(
      hit.decisions.includes("DEC-deadbee"),
      `Step 4: decisions array wrong, got ${JSON.stringify(hit.decisions)}`,
    );

    const miss = getScopeIndexEntry(repoRoot, "src/auth/other.ts");
    assert(miss === null, "Step 4: missing path should resolve to null");

    // Build legend with scope hint — should produce header lines
    const matches = scanCitations("// §INV-4141414 cited");
    const hint: ScopeIndexHint = {
      decisions: hit.decisions,
      invariants: hit.invariants,
    };
    const ledger = getInvariantsLedger(repoRoot); // null is fine here
    const legend = buildLegend(matches, ledger, null, hint, (id) =>
      lookupTask(repoRoot, id),
    );
    assert(legend !== null, "Step 4: legend with scope-hint should be non-null");
    if (legend === null) return;
    assert(
      legend.includes("Decisions in scope") || legend.includes("DEC-deadbee"),
      `Step 4: legend should reference scope decisions, got ${legend}`,
    );
    console.log("  ✓ Step 4 — scope-index legend integration");
  }

  // ── Step 5 — large content cap is just a documentation hint ──────
  // (The runReadEnricher entry point enforces the 512KB cap via stdin parsing;
  // the building blocks themselves don't enforce it. We don't smoke the stdin
  // path here — that requires shelling out. Skip.)

  console.log("smoke-read-enrich — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
