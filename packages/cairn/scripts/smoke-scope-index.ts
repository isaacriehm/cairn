#!/usr/bin/env tsx
/**
 * smoke-scope-index — readScopeIndex / writeScopeIndex / lookupScope
 * round-trip. Pure-mechanical, no LLM burn.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lookupScope,
  readScopeIndex,
  writeScopeIndex,
  type ScopeIndex,
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
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-scope-index-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-scope-index — start");

  const repoRoot = mkFixture();
  mkdirSync(join(repoRoot, ".harness", "ground"), { recursive: true });

  // ── Step 1 — read absent index → null ────────────────────────────
  {
    const idx = readScopeIndex(repoRoot);
    assert(
      idx === null,
      `Step 1: expected null on absent scope-index, got ${String(idx)}`,
    );
    console.log("  ✓ Step 1 — absent → null");
  }

  // ── Step 2 — write + read round-trip ─────────────────────────────
  const sample: ScopeIndex = {
    generated: "2026-05-04T03:00:00Z",
    files: {
      "src/auth/login.ts": {
        decisions: ["DEC-0042", "DEC-0089"],
        invariants: ["V0041", "V0052"],
      },
      "src/dashboard/index.tsx": {
        decisions: ["DEC-0017"],
        invariants: [],
      },
      ".eslintrc.json": {
        decisions: [],
        invariants: [],
        unscoped: true,
      },
    },
  };
  writeScopeIndex(repoRoot, sample);

  const idx = readScopeIndex(repoRoot);
  assert(idx !== null, "Step 2: round-trip read should not be null");
  if (idx === null) return; // narrow for TS — already asserted
  console.log("  ✓ Step 2 — write + read round-trip");

  // ── Step 3 — lookupScope known + missing entries ─────────────────
  {
    const login = lookupScope(idx, "src/auth/login.ts");
    assert(login !== null, "Step 3: src/auth/login.ts should resolve");
    if (login === null) return;
    assert(
      login.decisions.length === 2 && login.decisions.includes("DEC-0042"),
      `Step 3: login decisions wrong, got ${JSON.stringify(login.decisions)}`,
    );
    assert(
      login.invariants.includes("V0041"),
      `Step 3: login invariants wrong, got ${JSON.stringify(login.invariants)}`,
    );

    const missing = lookupScope(idx, "src/auth/missing.ts");
    assert(missing === null, "Step 3: missing path should resolve to null");

    const lint = lookupScope(idx, ".eslintrc.json");
    assert(lint !== null, "Step 3: unscoped entry still resolves");
    if (lint === null) return;
    assert(
      lint.unscoped === true,
      "Step 3: unscoped flag should round-trip",
    );
    console.log("  ✓ Step 3 — lookupScope hit/miss/unscoped");
  }

  console.log("smoke-scope-index — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
