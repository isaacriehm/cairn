#!/usr/bin/env tsx
/**
 * smoke-id-content-addressed — verifies the content-addressed
 * `computeDecisionId` / `computeInvariantId` helpers.
 *
 * Covers:
 *   1. Identical inputs produce identical ids (idempotent re-ingest).
 *   2. Different rationale → different id.
 *   3. Different source_file → different id.
 *   4. Hash collision against an existing Set bumps to 8+ chars.
 *   5. Output matches the canonical `^DEC-[0-9a-f]{7,}$` regex.
 */

import {
  computeDecisionId,
  computeInvariantId,
} from "@isaacriehm/cairn-core";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}

const ID_RE = /^DEC-[0-9a-f]{7,}$/;
const INV_RE = /^INV-[0-9a-f]{7,}$/;

function runSmoke(): void {
  console.log("smoke-id-content-addressed — start");

  // ── Step 1 — idempotent on identical input ──────────────────────
  {
    const a = computeDecisionId({
      title: "Use Postgres for primary store",
      rationale: "Operator prefers Postgres + Drizzle.",
      capture_source: "init-source-comments",
      source_file: "src/db.ts",
      source_offset: 42,
      raw: "// We chose Postgres because …",
    });
    const b = computeDecisionId({
      title: "Use Postgres for primary store",
      rationale: "Operator prefers Postgres + Drizzle.",
      capture_source: "init-source-comments",
      source_file: "src/db.ts",
      source_offset: 42,
      raw: "// We chose Postgres because …",
    });
    assert(a === b, `Step 1: identical input must produce identical id, got ${a} vs ${b}`);
    assert(ID_RE.test(a), `Step 1: id must match canonical regex, got ${a}`);
    console.log(`  PASS  Step 1 — idempotent (${a})`);
  }

  // ── Step 2 — different rationale → different id ─────────────────
  {
    const base = {
      title: "Cache layer behavior",
      capture_source: "user-record",
      source_file: "src/cache.ts",
      source_offset: 10,
    };
    const a = computeDecisionId({ ...base, rationale: "TTL of 60 seconds." });
    const b = computeDecisionId({ ...base, rationale: "TTL of 600 seconds." });
    assert(a !== b, `Step 2: distinct rationale must produce distinct ids, both got ${a}`);
    console.log(`  PASS  Step 2 — rationale change → ${a} ≠ ${b}`);
  }

  // ── Step 3 — different source_file → different id ───────────────
  {
    const base = {
      title: "Title common across files",
      rationale: "Same prose.",
      capture_source: "init-source-comments",
      source_offset: 1,
      raw: "// header",
    };
    const a = computeDecisionId({ ...base, source_file: "src/a.ts" });
    const b = computeDecisionId({ ...base, source_file: "src/b.ts" });
    assert(a !== b, `Step 3: different source_file must produce different ids`);
    console.log(`  PASS  Step 3 — source_file change → ${a} ≠ ${b}`);
  }

  // ── Step 4 — collision against existing Set bumps to 8+ chars ───
  {
    const real = computeDecisionId({ title: "alpha", capture_source: "user-record" });
    // Simulate a colliding 7-char prefix already on disk (the real
    // function always returns the 7-char form when no collision; here
    // we feed the same id back in and expect it to extend.)
    const existing = new Set([real]);
    const next = computeDecisionId(
      { title: "alpha", capture_source: "user-record" },
      existing,
    );
    assert(
      next !== real && next.length > real.length,
      `Step 4: collision against existing must bump length, got ${next} vs ${real}`,
    );
    assert(next.startsWith(real), `Step 4: extended id must share the 7-char prefix, got ${next}`);
    console.log(`  PASS  Step 4 — collision bumps to ${next.length - 4} chars`);
  }

  // ── Step 5 — INV ids match the invariant regex ──────────────────
  {
    const inv = computeInvariantId({
      title: "All routes carry tenant guard",
      source_file: "src/api/routes.ts",
      source_offset: 12,
      raw: "// MUST guard …",
    });
    assert(INV_RE.test(inv), `Step 5: INV id must match canonical regex, got ${inv}`);
    console.log(`  PASS  Step 5 — INV regex (${inv})`);
  }

  console.log("smoke-id-content-addressed — pass");
}

runSmoke();
