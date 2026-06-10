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
  emptyTopicIndex,
  getFileCandidateCount,
  getInvariantsLedger,
  getScopeIndexEntry,
  scanCitations,
  setTopic,
  writeFileCandidatesMap,
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
    // The `// TODO(TSK-foo)` line in the sample is now IGNORED — the dead
    // source-marker reader was cut, so it must not perturb the §INV/§DEC scan.
    assert(
      matches.decisions.length === 1 && matches.decisions[0]?.id === "DEC-deadbee",
      `Step 1: expected one §DEC-deadbee match, got ${JSON.stringify(matches.decisions)}`,
    );
    console.log("  ✓ Step 1 — scanCitations (DEC requires § prefix; TODO(TSK-) ignored)");
  }

  // ── Step 2 — empty content → buildLegend returns null ────────────
  {
    const empty = scanCitations("");
    const result = buildLegend(empty, null, null, null);
    assert(result === null, `Step 2: expected null on empty input, got ${String(result)}`);
    console.log("  ✓ Step 2 — empty content → null legend");
  }

  // ── Step 3 — non-empty citations produce a legend block ──────────
  {
    const matches = scanCitations("// §INV-2323232 something");
    const result = buildLegend(matches, null, null, null);
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
    const legend = buildLegend(matches, ledger, null, hint);
    assert(legend !== null, "Step 4: legend with scope-hint should be non-null");
    if (legend === null) return;
    assert(
      legend.includes("Decisions in scope") || legend.includes("DEC-deadbee"),
      `Step 4: legend should reference scope decisions, got ${legend}`,
    );
    console.log("  ✓ Step 4 — scope-index legend integration");
  }

  // ── Step 5 — candidate-count hint (PHASE_6_REDESIGN §4.7) ─────────
  // PR 2: file-candidates-map.yaml feeds the read-enricher hint via
  // O(1) lookup. When a file is the SoT for ≥1 unpromoted candidate
  // the legend prepends a curator prompt for the AI agent.
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });
    // Seed a topic-index with two unpromoted candidates anchored at
    // docs/auth.md so the file-candidates-map writer counts 2.
    let ti = emptyTopicIndex();
    for (const slug of ["topic-a", "topic-b"]) {
      ti = setTopic(ti, slug, {
        slug,
        sot_source: "docs/auth.md",
        candidates: [
          {
            file: "docs/auth.md",
            kind: "doc",
            line_range: [1, 10],
          },
        ],
        created_at: "2026-05-04T03:00:00Z",
      });
    }
    // Plus one promoted candidate that should NOT be counted.
    ti = setTopic(ti, "topic-c", {
      slug: "topic-c",
      sot_source: "docs/tokens.md",
      candidates: [
        {
          file: "docs/tokens.md",
          kind: "doc",
          line_range: [1, 10],
        },
      ],
      created_at: "2026-05-04T03:00:00Z",
      dec_id: "DEC-1234567",
    });
    writeFileCandidatesMap(repoRoot, ti);

    // Step 5a — getFileCandidateCount returns the per-file count.
    const authCount = getFileCandidateCount(repoRoot, "docs/auth.md");
    assert(
      authCount === 2,
      `Step 5a: expected 2 candidates for docs/auth.md, got ${authCount}`,
    );
    const tokensCount = getFileCandidateCount(repoRoot, "docs/tokens.md");
    assert(
      tokensCount === 0,
      `Step 5a: docs/tokens.md should be 0 (its candidate is promoted), got ${tokensCount}`,
    );
    const missingCount = getFileCandidateCount(repoRoot, "docs/missing.md");
    assert(
      missingCount === 0,
      `Step 5a: missing file should report 0, got ${missingCount}`,
    );

    // Step 5b — buildLegend with no citations + no scope BUT
    // candidates=N produces a curator-hint-only legend.
    const empty = scanCitations("");
    const legend = buildLegend(empty, null, null, null, authCount);
    assert(legend !== null, "Step 5b: candidate hint alone should produce a legend");
    if (legend === null) return;
    assert(
      legend.includes("2 unpromoted topic-index candidates"),
      `Step 5b: legend should report the count, got ${legend}`,
    );
    assert(
      legend.includes("cairn_record_decision"),
      `Step 5b: legend should mention the propose tool, got ${legend}`,
    );
    assert(
      legend.includes("Do NOT propose for narrative"),
      `Step 5b: legend should include the "Do NOT propose for narrative" guardrail, got ${legend}`,
    );

    // Step 5c — when count=0, no hint is added (stays silent).
    const silent = buildLegend(empty, null, null, null, 0);
    assert(
      silent === null,
      `Step 5c: count=0 + no citations + no scope should remain null, got ${silent}`,
    );

    // Step 5d — when both candidate hint + citations exist, both
    // appear in the same output, with the curator hint above the box.
    const withCitations = scanCitations("// §INV-2323232 cited");
    const combined = buildLegend(withCitations, null, null, null, authCount);
    assert(combined !== null, "Step 5d: candidate hint + citation should combine");
    if (combined === null) return;
    const hintIdx = combined.indexOf("2 unpromoted");
    const boxIdx = combined.indexOf("cairn citations");
    assert(
      hintIdx >= 0 && boxIdx >= 0 && hintIdx < boxIdx,
      `Step 5d: candidate hint should sit above the citation box. hintIdx=${hintIdx} boxIdx=${boxIdx}`,
    );
    console.log("  ✓ Step 5 — candidate-count hint via file-candidates-map.yaml");
  }

  console.log("smoke-read-enrich — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
