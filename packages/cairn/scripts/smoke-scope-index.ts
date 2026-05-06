#!/usr/bin/env tsx
/**
 * smoke-scope-index — readScopeIndex / writeScopeIndex / lookupScope
 * round-trip. Pure-mechanical, no LLM burn.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coerceDecisionIds,
  coerceInvariantIds,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-scope-index-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-scope-index — start");

  const repoRoot = mkFixture();
  mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });

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
        decisions: ["DEC-deadbee", "DEC-c0ffee1"],
        invariants: ["INV-4141414", "INV-5252525"],
      },
      "src/dashboard/index.tsx": {
        decisions: ["DEC-2222222"],
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
      login.decisions.length === 2 && login.decisions.includes("DEC-deadbee"),
      `Step 3: login decisions wrong, got ${JSON.stringify(login.decisions)}`,
    );
    assert(
      login.invariants.includes("INV-4141414"),
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

  // ── Step 4 — coerceDecisionIds / coerceInvariantIds drop prose ──
  // Mapper LLMs occasionally smuggle ledger title text past the JSON-mode
  // gate. The coercer must extract the canonical ID from each entry and
  // silently drop strings that contain no ID, so the on-disk scope-index
  // never carries prose for the read-enricher legend to render.
  {
    const dirtyDecisions = [
      "DEC-deadbee",
      "HS256 chosen over RS256: single deployment, no key-rotation requirement",
      "DEC-2222222 — Use explicit route files over decorator routers",
      "Stripe is the only permitted payment processor.",
    ];
    const cleanDecisions = coerceDecisionIds(dirtyDecisions);
    assert(
      cleanDecisions.length === 2 &&
        cleanDecisions[0] === "DEC-deadbee" &&
        cleanDecisions[1] === "DEC-2222222",
      `Step 4: decision coerce wrong, got ${JSON.stringify(cleanDecisions)}`,
    );

    const dirtyInvariants = [
      "INV-1111111",
      "TOKEN_TTL_MS = 24 hours; tokens with iat older than 24h must be rejected",
      "INV-2323232 — HTTP layer is the only public surface",
      "Redactor implemented in Python for legacy reasons",
    ];
    const cleanInvariants = coerceInvariantIds(dirtyInvariants);
    assert(
      cleanInvariants.length === 2 &&
        cleanInvariants[0] === "INV-1111111" &&
        cleanInvariants[1] === "INV-2323232",
      `Step 4: invariant coerce wrong, got ${JSON.stringify(cleanInvariants)}`,
    );

    // Dedupe + non-string filter
    const mixed: unknown[] = ["DEC-a3f7b2c", "DEC-a3f7b2c", 42, null, "DEC-5e9d10a"];
    const deduped = coerceDecisionIds(mixed);
    assert(
      deduped.length === 2 && deduped[0] === "DEC-a3f7b2c" && deduped[1] === "DEC-5e9d10a",
      `Step 4: dedupe/filter wrong, got ${JSON.stringify(deduped)}`,
    );

    console.log("  ✓ Step 4 — ID coercion drops prose, dedupes, filters non-strings");
  }

  console.log("smoke-scope-index — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
