#!/usr/bin/env tsx
/**
 * smoke-migrate — coded `.cairn/` migration registry (WS3).
 *
 * Drives `runMigrations` against temp `.cairn/` fixtures:
 *   - dry-run reports pending without mutating
 *   - the safe 0001 migration removes dead config keys + bumps the pin
 *   - re-running is an idempotent no-op
 *   - a frozen pin with no pending work still advances to current
 *   - a held migrate lock makes the run bail (ran: false), not race
 *   - an unadopted repo is a clean no-op (never creates .cairn/)
 *
 * No LLM burn.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  MIGRATIONS,
  runMigrations,
  readConfigPin,
  remediateGitignore,
  VERSION,
} from "@isaacriehm/cairn-core";

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

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

function mkRepo(configYaml: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-migrate-"));
  cleanups.push(dir);
  if (configYaml !== null) {
    mkdirSync(join(dir, ".cairn"), { recursive: true });
    writeFileSync(join(dir, ".cairn", "config.yaml"), configYaml, "utf8");
  }
  return dir;
}

function readConfig(repoRoot: string): Record<string, unknown> {
  const raw = readFileSync(join(repoRoot, ".cairn", "config.yaml"), "utf8");
  return (parseYaml(raw) ?? {}) as Record<string, unknown>;
}

const DIRTY_CONFIG = [
  "version: 1",
  "cairn_version: 0.9.4",
  "slug: demo",
  "domain_summary: A demo project.",
  "origin_url: git@example.com:demo.git",
  "stack_signatures:",
  "  - typescript",
  "hook_capability: claude-code",
  "start_command:",
  "  command: pnpm",
  "  args: [run, dev]",
  "detected_sensor_commands:",
  "  - id: tsc",
  "mapper_proposed_sensors: []",
  "mapper_notes: some notes",
  "key_modules: []",
  "",
].join("\n");

async function runSmoke(): Promise<void> {
  console.log("smoke-migrate — start");

  // ── Step 1 — dry-run reports pending, mutates nothing ─────────────
  {
    const repoRoot = mkRepo(DIRTY_CONFIG);
    const before = readFileSync(join(repoRoot, ".cairn", "config.yaml"), "utf8");
    const result = await runMigrations({ repoRoot, dryRun: true });
    assert(result.ran === true, "Step 1: dry-run should report ran=true");
    assert(
      result.outcomes.some((o) => o.id === "0001-drop-dead-config-fields"),
      `Step 1: 0001 should be pending, got ${JSON.stringify(result.outcomes)}`,
    );
    assert(
      result.outcomes.every((o) => o.status === "would-apply"),
      "Step 1: dry-run outcomes should be would-apply",
    );
    const after = readFileSync(join(repoRoot, ".cairn", "config.yaml"), "utf8");
    assert(before === after, "Step 1: dry-run must not mutate config.yaml");
    console.log("  ✓ Step 1 — dry-run reports, no mutation");
  }

  // ── Step 2 — safe migration drops dead keys + bumps pin ───────────
  {
    const repoRoot = mkRepo(DIRTY_CONFIG);
    const result = await runMigrations({ repoRoot });
    assert(result.ran === true, "Step 2: run should complete");
    assert(
      result.outcomes.some(
        (o) => o.id === "0001-drop-dead-config-fields" && o.status === "applied",
      ),
      `Step 2: 0001 should apply, got ${JSON.stringify(result.outcomes)}`,
    );
    assert(
      result.newPin === VERSION,
      `Step 2: pin should bump to ${VERSION}, got ${result.newPin}`,
    );

    const cfg = readConfig(repoRoot);
    for (const dead of [
      "origin_url",
      "stack_signatures",
      "hook_capability",
      "start_command",
      "detected_sensor_commands",
      "mapper_proposed_sensors",
      "mapper_notes",
      "key_modules",
    ]) {
      assert(!(dead in cfg), `Step 2: dead key '${dead}' should be removed`);
    }
    assert(cfg["domain_summary"] === "A demo project.", "Step 2: domain_summary kept");
    assert(cfg["slug"] === "demo", "Step 2: slug kept");
    assert(cfg["cairn_version"] === VERSION, "Step 2: cairn_version bumped on disk");
    console.log("  ✓ Step 2 — dead keys dropped, pin bumped, kept keys preserved");
  }

  // ── Step 3 — re-run is an idempotent no-op ────────────────────────
  {
    const repoRoot = mkRepo(DIRTY_CONFIG);
    await runMigrations({ repoRoot });
    const second = await runMigrations({ repoRoot });
    assert(second.ran === true, "Step 3: second run completes");
    assert(
      second.outcomes.length === 0 && second.newPin === null,
      `Step 3: second run should be a no-op, got ${JSON.stringify(second)}`,
    );
    console.log("  ✓ Step 3 — idempotent re-run");
  }

  // ── Step 4 — frozen pin, no dead keys → pin still advances ────────
  {
    const repoRoot = mkRepo("version: 1\ncairn_version: 0.9.4\nslug: clean\n");
    const result = await runMigrations({ repoRoot });
    assert(
      result.outcomes.length === 0,
      `Step 4: no migrations should be needed, got ${JSON.stringify(result.outcomes)}`,
    );
    assert(result.newPin === VERSION, `Step 4: stale pin should bump to ${VERSION}, got ${result.newPin}`);
    assert(readConfigPin(repoRoot) === VERSION, "Step 4: pin live on disk");
    console.log("  ✓ Step 4 — frozen pin made live");
  }

  // ── Step 5 — held lock → bail cleanly (ran: false) ────────────────
  {
    const repoRoot = mkRepo(DIRTY_CONFIG);
    const lockPath = join(repoRoot, ".cairn", ".migrate-lock");
    // Current (alive) PID holds the lock → acquireOperationLock throws.
    writeFileSync(lockPath, `${process.pid}\n`, "utf8");
    const result = await runMigrations({ repoRoot });
    assert(result.ran === false, `Step 5: held lock should bail, got ran=${result.ran}`);
    // Config untouched while the lock was held.
    const cfg = readConfig(repoRoot);
    assert("origin_url" in cfg, "Step 5: config must be untouched under a held lock");
    console.log("  ✓ Step 5 — held lock bails without racing");
  }

  // ── Step 6 — unadopted repo is a clean no-op ──────────────────────
  {
    const repoRoot = mkRepo(null);
    const result = await runMigrations({ repoRoot });
    assert(result.ran === true && result.outcomes.length === 0, "Step 6: unadopted no-op");
    assert(!existsSync(join(repoRoot, ".cairn")), "Step 6: must NOT create .cairn/ on unadopted repo");
    console.log("  ✓ Step 6 — unadopted repo untouched");
  }

  // ── Step 7 — 0002 backfills .cairn/.gitignore + untracks committed state ──
  {
    const repoRoot = mkRepo("version: 1\ncairn_version: 0.14.0\nslug: gi\n");
    git(repoRoot, ["init", "-q"]);
    // Stale gitignore (only sessions/) + a COMMITTED derived file the current
    // template ignores — the pre-v0.15 adopter shape.
    writeFileSync(join(repoRoot, ".cairn", ".gitignore"), "sessions/\n", "utf8");
    mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });
    writeFileSync(join(repoRoot, ".cairn", "ground", "manifest.yaml"), "files: {}\n", "utf8");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["-c", "user.email=s@s", "-c", "user.name=s", "commit", "-q", "-m", "seed"]);

    const preview = remediateGitignore(repoRoot, { apply: false });
    assert(preview.changed, "Step 7: detect should report changes");
    assert(
      preview.addedEntries.includes("ground/manifest.yaml"),
      `Step 7: manifest ignore-entry missing, got ${preview.addedEntries.join(",")}`,
    );
    assert(
      preview.untracked.some((p) => p.endsWith("ground/manifest.yaml")),
      `Step 7: should see tracked manifest, got ${preview.untracked.join(",")}`,
    );
    assert(
      readFileSync(join(repoRoot, ".cairn", ".gitignore"), "utf8") === "sessions/\n",
      "Step 7: preview (apply:false) must not write",
    );

    const applied = remediateGitignore(repoRoot, { apply: true });
    assert(applied.changed, "Step 7: apply should report changed");
    const gi = readFileSync(join(repoRoot, ".cairn", ".gitignore"), "utf8");
    assert(gi.startsWith("sessions/"), "Step 7: existing operator line preserved");
    assert(gi.includes("ground/manifest.yaml"), "Step 7: missing entry appended");
    assert(
      git(repoRoot, ["ls-files", "--", ".cairn/ground/manifest.yaml"]).trim() === "",
      "Step 7: committed manifest should be untracked",
    );

    const again = remediateGitignore(repoRoot, { apply: false });
    assert(!again.changed, "Step 7: second detect is an idempotent no-op");
    console.log("  ✓ Step 7 — 0002 backfills gitignore + untracks committed derived state");
  }

  // ── Step 8 — 0003 prunes one-time init scaffolding ────────────────
  {
    const pruneScaffolding = MIGRATIONS.find((m) => m.id === "0003-prune-scaffolding");
    assert(pruneScaffolding !== undefined, "Step 8: 0003 registered");
    const repoRoot = mkRepo("version: 1\ncairn_version: 0.22.0\nslug: demo\n");
    mkdirSync(join(repoRoot, ".cairn", "init", "curator"), { recursive: true });
    writeFileSync(join(repoRoot, ".cairn", "init", "mapper-output.json"), "{}", "utf8");
    mkdirSync(join(repoRoot, ".cairn", "backups", "source"), { recursive: true });
    writeFileSync(join(repoRoot, ".cairn", "backups", "source", "f.ts.original"), "x", "utf8");

    assert(pruneScaffolding.introducedIn === "0.22.1", "Step 8: pinned to the 0.22.1 release");
    assert(pruneScaffolding.class === "review", "Step 8: must be review-class (deletes state)");
    assert(pruneScaffolding.detect(repoRoot), "Step 8: detect should fire with scaffolding present");

    const applied = pruneScaffolding.apply(repoRoot);
    assert(applied.changed, "Step 8: apply should report changed");
    assert(!existsSync(join(repoRoot, ".cairn", "init")), "Step 8: init/ removed");
    assert(!existsSync(join(repoRoot, ".cairn", "backups")), "Step 8: backups/ removed");
    assert(existsSync(join(repoRoot, ".cairn", "config.yaml")), "Step 8: config.yaml untouched");

    assert(!pruneScaffolding.detect(repoRoot), "Step 8: detect is a no-op after prune");
    assert(!pruneScaffolding.apply(repoRoot).changed, "Step 8: re-apply is an idempotent no-op");
    console.log("  ✓ Step 8 — 0003 prunes init/ + backups/ scaffolding, idempotent");
  }

  // ── Step 9 — 0004 drops the defunct glob-driven sensor settings ──────
  {
    const drop = MIGRATIONS.find((m) => m.id === "0004-drop-glob-settings");
    assert(drop !== undefined, "Step 9: 0004 registered");
    assert(drop.class === "safe", "Step 9: 0004 is safe-class (value-preserving)");
    const cfgYaml = [
      "version: 1",
      "cairn_version: 0.22.5",
      "slug: globs",
      "off_limits:",
      "  - dist/",
      "high_stakes_globs:",
      '  - "**/auth/**"',
      "defer_hours: 24",
      "project_globs:",
      "  route_handler_globs:",
      "    - core/src/api/*.controller.ts",
      "  dto_globs: []",
      "  generator_source_globs: []",
      "  high_stakes_globs:",
      '    - "**/auth/**"',
      "",
    ].join("\n");
    const repoRoot = mkRepo(cfgYaml);
    assert(drop.detect(repoRoot), "Step 9: detect fires while glob settings present");
    const applied = drop.apply(repoRoot);
    assert(applied.changed, "Step 9: apply reports changed");

    const cfg = readConfig(repoRoot);
    assert(!("project_globs" in cfg), "Step 9: project_globs removed");
    assert(!("high_stakes_globs" in cfg), "Step 9: top-level high_stakes_globs removed");
    // Kept keys survive.
    assert(
      JSON.stringify(cfg["off_limits"]) === JSON.stringify(["dist/"]),
      `Step 9: off_limits preserved, got ${JSON.stringify(cfg["off_limits"])}`,
    );
    assert(cfg["slug"] === "globs" && cfg["defer_hours"] === 24, "Step 9: sibling keys preserved");
    assert(!drop.detect(repoRoot), "Step 9: detect is a no-op after drop");
    assert(!drop.apply(repoRoot).changed, "Step 9: re-apply is idempotent");
    console.log("  ✓ Step 9 — 0004 drops project_globs + high_stakes_globs, keeps off_limits, idempotent");
  }

  console.log("smoke-migrate — pass");
}

try {
  await runSmoke();
} finally {
  cleanup();
}
