#!/usr/bin/env tsx
/**
 * smoke-empty-ground — verifies graceful behaviour when .cairn/ground/ is
 * empty or partially missing (invariants dir absent, decisions ledger absent).
 *
 * Covers:
 *   1. resolveInvariant with no invariants dir -> unknown (no throw)
 *   2. resolveDecision with no decisions dir -> unknown (no throw)
 *   3. resolveScopeWithTitles with scope-index present but ledgers absent
 *      -> returns scope entry with raw ids as titles (no throw)
 *   4. resolveDecision with non-accepted (draft) DEC -> unknown (not exposed)
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScopeIndex } from "@isaacriehm/cairn-core";
import { LensResolver } from "../dist/resolver.js";

const cleanups: string[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-lens-empty-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-empty-ground — start");

  // 1. resolveInvariant with no invariants dir -> unknown (no throw)
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });
    // no invariants/ subdir
    const resolver = new LensResolver(repoRoot);
    let threw = false;
    let result;
    try {
      result = resolver.resolveInvariant("INV-9999999");
    } catch {
      threw = true;
    }
    assert(!threw, "Step 1: resolveInvariant threw with no invariants dir");
    assert(result?.status === "unknown", `Step 1: expected unknown, got ${result?.status}`);
    console.log("  PASS  Step 1 — resolveInvariant no invariants dir -> unknown");
  }

  // 2. resolveDecision with no decisions dir -> unknown (no throw)
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });
    const resolver = new LensResolver(repoRoot);
    let threw = false;
    let result;
    try {
      result = resolver.resolveDecision("DEC-a3f7b2c");
    } catch {
      threw = true;
    }
    assert(!threw, "Step 2: resolveDecision threw with no decisions dir");
    assert(result?.status === "unknown", `Step 2: expected unknown, got ${result?.status}`);
    console.log("  PASS  Step 2 — resolveDecision no decisions dir -> unknown");
  }

  // 3. resolveScopeWithTitles with scope-index present but ledgers absent
  //    -> returns scope entry with raw ids (no throw)
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });
    writeScopeIndex(repoRoot, {
      generated: "2026-05-05T00:00:00Z",
      files: {
        "src/main.ts": {
          decisions: ["DEC-a3f7b2c", "DEC-5e9d10a"],
          invariants: ["INV-1111111"],
        },
      },
    });
    const resolver = new LensResolver(repoRoot);
    let threw = false;
    let scope;
    try {
      scope = resolver.resolveScopeWithTitles("src/main.ts");
    } catch {
      threw = true;
    }
    assert(!threw, "Step 3: resolveScopeWithTitles threw");
    assert(scope !== null, "Step 3: scope should be non-null");
    if (scope !== null) {
      assert(
        scope.decisions.length === 2,
        `Step 3: expected 2 decisions, got ${scope.decisions.length}`,
      );
      // When ledger is absent, title falls back to id
      assert(
        scope.decisions[0]?.id === "DEC-a3f7b2c" && scope.decisions[0]?.title === "DEC-a3f7b2c",
        `Step 3: title fallback wrong: ${JSON.stringify(scope.decisions[0])}`,
      );
      assert(
        scope.invariants.length === 1 && scope.invariants[0]?.id === "INV-1111111",
        `Step 3: invariants wrong: ${JSON.stringify(scope.invariants)}`,
      );
    }
    console.log("  PASS  Step 3 — resolveScopeWithTitles no ledgers -> raw ids as titles");
  }

  // 4. resolveDecision with non-accepted (draft) DEC -> unknown
  {
    const repoRoot = mkFixture();
    const decDir = join(repoRoot, ".cairn", "ground", "decisions");
    mkdirSync(decDir, { recursive: true });
    writeFileSync(
      join(decDir, "DEC-50d8a51.md"),
      `---\nid: DEC-50d8a51\ntitle: Draft decision\nstatus: draft\n---\n`,
      "utf8",
    );
    const resolver = new LensResolver(repoRoot);
    const r = resolver.resolveDecision("DEC-50d8a51");
    // buildDecisionsLedger only includes accepted; draft should not appear
    assert(
      r.status === "unknown",
      `Step 4: draft DEC should resolve to unknown, got ${r.status}`,
    );
    console.log("  PASS  Step 4 — draft DEC -> unknown (not exposed via lens)");
  }

  console.log("smoke-empty-ground — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
