#!/usr/bin/env tsx
/**
 * smoke-config-globs — `cairn doctor` config-glob staleness check.
 *
 * Verifies the check added in WS2: a `config.yaml` scope glob that matches
 * zero working-tree files surfaces as a `warn`, while globs that still match
 * stay `ok`. Pure-mechanical, no LLM burn.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDoctor } from "@isaacriehm/cairn-core";

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

function write(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-config-globs-"));
  cleanups.push(dir);
  // Minimal adoption shell so the unrelated doctor checks don't crash.
  mkdirSync(join(dir, ".cairn", "ground"), { recursive: true });
  return dir;
}

function configGlobsCheck(repoRoot: string) {
  const report = runDoctor({ repoRoot });
  const check = report.checks.find((c) => c.label === "config globs");
  assert(check !== undefined, "expected a 'config globs' check in the report");
  return check;
}

function runSmoke(): void {
  console.log("smoke-config-globs — start");

  // ── Step 1 — no scope globs configured → check is absent ──────────
  {
    const repoRoot = mkFixture();
    write(repoRoot, ".cairn/config.yaml", "cairn_version: 0.0.0\n");
    const report = runDoctor({ repoRoot });
    const check = report.checks.find((c) => c.label === "config globs");
    assert(
      check === undefined,
      `Step 1: no globs configured should emit no config-globs check, got ${JSON.stringify(check)}`,
    );
    console.log("  ✓ Step 1 — no globs → no check");
  }

  // ── Step 2 — all globs match tree files → ok ──────────────────────
  {
    const repoRoot = mkFixture();
    write(
      repoRoot,
      ".cairn/config.yaml",
      [
        "cairn_version: 0.0.0",
        "high_stakes_globs:",
        "  - src/auth/**/*.ts",
        "project_globs:",
        "  route_handler_globs:",
        "    - src/**/*.controller.ts",
        "  dto_globs:",
        "    - src/**/*.dto.ts",
        "",
      ].join("\n"),
    );
    write(repoRoot, "src/auth/login.ts", "export const x = 1;\n");
    write(repoRoot, "src/users/users.controller.ts", "export class C {}\n");
    write(repoRoot, "src/users/user.dto.ts", "export class D {}\n");

    const check = configGlobsCheck(repoRoot);
    assert(
      check.status === "ok",
      `Step 2: all-matching globs should be ok, got ${check.status} — ${check.detail}`,
    );
    console.log("  ✓ Step 2 — all globs match → ok");
  }

  // ── Step 3 — a stale glob (post-refactor) → warn + names it ───────
  {
    const repoRoot = mkFixture();
    write(
      repoRoot,
      ".cairn/config.yaml",
      [
        "cairn_version: 0.0.0",
        "project_globs:",
        "  route_handler_globs:",
        // Adoption recorded the pre-refactor layout (no `src/` level)…
        "    - api/**/*.controller.ts",
        "  dto_globs:",
        // …this one survived the refactor.
        "    - src/**/*.dto.ts",
        "",
      ].join("\n"),
    );
    // Tree moved under src/ — the route glob now matches nothing.
    write(repoRoot, "src/api/users.controller.ts", "export class C {}\n");
    write(repoRoot, "src/api/user.dto.ts", "export class D {}\n");

    const check = configGlobsCheck(repoRoot);
    assert(
      check.status === "warn",
      `Step 3: stale glob should warn, got ${check.status} — ${check.detail}`,
    );
    assert(
      check.detail.includes("api/**/*.controller.ts"),
      `Step 3: warn detail should name the stale glob, got: ${check.detail}`,
    );
    assert(
      !check.detail.includes("src/**/*.dto.ts"),
      `Step 3: warn detail should not name the still-matching glob, got: ${check.detail}`,
    );
    console.log("  ✓ Step 3 — stale glob → warn naming it");
  }

  // ── Step 4 — .cairn/ is skipped (config lives there, not source) ──
  {
    const repoRoot = mkFixture();
    write(
      repoRoot,
      ".cairn/config.yaml",
      [
        "cairn_version: 0.0.0",
        "high_stakes_globs:",
        "  - .cairn/**/*.yaml",
        "",
      ].join("\n"),
    );
    write(repoRoot, "src/app.ts", "export const x = 1;\n");

    const check = configGlobsCheck(repoRoot);
    // The walk skips `.cairn/`, so a glob pointed only inside it matches zero.
    assert(
      check.status === "warn",
      `Step 4: glob scoped to skipped .cairn/ should warn, got ${check.status} — ${check.detail}`,
    );
    console.log("  ✓ Step 4 — .cairn/ excluded from the walk");
  }

  console.log("smoke-config-globs — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
