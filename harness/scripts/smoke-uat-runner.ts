#!/usr/bin/env tsx
/**
 * smoke-uat-runner — Phase 11 UAT-runner agent acceptance.
 *
 * Verifies the runner picks the cheapest probe for each AC. Exercises:
 *   1. API spec → http probe (NOT ui)
 *   2. CLI spec  → cli probe
 *   3. High-stakes spec → at least one cross-tenant fixture marked
 *      `is_high_stakes_required = true`
 *
 * Burns ~3 cheap haiku-tier calls. SKIPS without `claude`.
 */

import { claudeIsAvailable } from "../src/claude/index.js";
import { generateUatChecks } from "../src/uat/index.js";

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-uat-runner FAIL: ${reason}`);
  process.exit(1);
}

function skip(reason: string): never {
  console.log(`smoke-uat-runner SKIP: ${reason}`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (!claudeIsAvailable()) skip("`claude` CLI not on PATH or not authenticated");

  // ── Scenario 1: API spec → http probe ─────────────────────────────────
  header("Step 1: API spec → http probe");
  let out = await generateUatChecks({
    tightened_spec:
      "Add a /health endpoint that returns JSON `{ status: 'ok', uptime_s: <number> }` with HTTP 200.",
    acceptance_criteria: [
      "GET /health returns HTTP 200",
      "Response body has `status` field equal to 'ok'",
      "Response body has `uptime_s` field of type number",
    ],
    changed_files: [{ path: "src/health.controller.ts", status: "added" }],
    hints: {
      base_url: "http://localhost:3000",
      cli_cwd: "/tmp/proj",
      ui_available: false,
      sql_available: false,
      integration_available: false,
    },
    is_high_stakes: false,
    tier: "haiku",
  });
  console.log(
    `  emitted ${out.acceptance_checks.length} checks; kinds=${out.acceptance_checks.map((c) => c.probe.kind).join(",")}`,
  );
  if (out.acceptance_checks.length === 0) {
    fail(`runner emitted zero checks; ungenerable_reason=${out.ungenerable_reason}`);
  }
  for (const check of out.acceptance_checks) {
    if (check.probe.kind !== "http") {
      fail(`expected http probe for API spec; got ${check.probe.kind} on ${check.id}`);
    }
  }
  if (out.backend_only !== true) {
    fail(`expected backend_only=true for API-only spec; got ${out.backend_only}`);
  }
  console.log("  ok=true (all probes are http; backend_only=true)");

  // ── Scenario 2: CLI spec → cli probe ─────────────────────────────────
  header("Step 2: CLI spec → cli probe");
  out = await generateUatChecks({
    tightened_spec:
      "Add a `harness echo <text>` CLI command. It writes `<text>` followed by a newline to stdout and exits 0.",
    acceptance_criteria: [
      "`harness echo hello` exits with code 0",
      "stdout is exactly `hello\\n`",
    ],
    changed_files: [{ path: "src/cli/echo.ts", status: "added" }],
    hints: {
      cli_cwd: "/tmp/proj",
      cli_prefix: "pnpm --filter harness",
      ui_available: false,
      sql_available: false,
      integration_available: false,
    },
    is_high_stakes: false,
    tier: "haiku",
  });
  console.log(
    `  emitted ${out.acceptance_checks.length} checks; kinds=${out.acceptance_checks.map((c) => c.probe.kind).join(",")}`,
  );
  if (out.acceptance_checks.length === 0) {
    fail(`runner emitted zero checks; ungenerable_reason=${out.ungenerable_reason}`);
  }
  for (const check of out.acceptance_checks) {
    if (check.probe.kind !== "cli") {
      fail(`expected cli probe; got ${check.probe.kind} on ${check.id}`);
    }
  }
  console.log("  ok=true (all probes are cli)");

  // ── Scenario 3: High-stakes → cross-tenant fixture ───────────────────
  header("Step 3: high-stakes spec → cross-tenant fixture flagged");
  out = await generateUatChecks({
    tightened_spec: [
      "Add /api/orders/:id endpoint. Returns the order JSON when the requesting user owns it; returns 404 otherwise.",
      "User-id scoping is enforced by `WHERE orders.user_id = current_user_id` in the query.",
    ].join("\n"),
    acceptance_criteria: [
      "GET /api/orders/:id returns 200 with order JSON when caller owns the order",
      "GET /api/orders/:id returns 404 when caller does NOT own the order (cross-tenant)",
    ],
    changed_files: [
      { path: "src/orders/orders.controller.ts", status: "modified" },
      { path: "src/orders/orders.service.ts", status: "modified" },
    ],
    hints: {
      base_url: "http://localhost:3000",
      ui_available: false,
      sql_available: false,
      integration_available: false,
    },
    is_high_stakes: true,
    tier: "haiku",
  });
  console.log(
    `  emitted ${out.acceptance_checks.length} checks; high_stakes_required=${out.acceptance_checks.filter((c) => c.is_high_stakes_required === true).length}`,
  );
  const crossTenant = out.acceptance_checks.find((c) => c.is_high_stakes_required === true);
  if (!crossTenant) {
    fail("expected at least one is_high_stakes_required=true check on high-stakes spec");
  }
  if (crossTenant?.probe.kind !== "http") {
    fail(`cross-tenant fixture should be http; got ${crossTenant?.probe.kind}`);
  }
  console.log(`  ok=true (cross-tenant fixture: ${crossTenant?.id} via ${crossTenant?.probe.kind})`);

  console.log("\nsmoke-uat-runner: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
