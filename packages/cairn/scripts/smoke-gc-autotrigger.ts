#!/usr/bin/env tsx
/**
 * smoke-gc-autotrigger — Stop-driven GC schedule (Q4 row 4) acceptance.
 *
 * Builds an ephemeral repo with a fake plugin bundle (so the spawn-arg
 * resolution finds `dist/cli.mjs`), then exercises the autotrigger:
 *
 *   1. First call (no marker)           → triggered, reason=first_run.
 *   2. Marker fresh (within threshold)  → suppressed, reason=fresh.
 *   3. Marker stale (>= threshold)      → triggered, reason=threshold_passed.
 *   4. No CLAUDE_PLUGIN_ROOT             → triggered=false, reason=no_plugin_root.
 *   5. Plugin root missing dist/cli.mjs  → triggered=false, reason=no_cli_bundle.
 *   6. Test spawner records argv shape  → cmd=node, args contain `gc sweep`,
 *      `--repo-root`, repoRoot.
 *   7. Marker is updated on trigger     → next call within threshold reads
 *      the new ISO and stays fresh.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runGcAutotriggerCheck,
  type GcAutotriggerArgv,
  type GcAutotriggerResult,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function makeRepo(): { repo: string; pluginRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "cairn-smoke-gc-auto-"));
  cleanups.push(repo);
  mkdirSync(resolve(repo, ".cairn"), { recursive: true });
  const pluginRoot = mkdtempSync(join(tmpdir(), "cairn-smoke-gc-plugin-"));
  cleanups.push(pluginRoot);
  mkdirSync(resolve(pluginRoot, "dist"), { recursive: true });
  writeFileSync(resolve(pluginRoot, "dist", "cli.mjs"), "// stub bundle\n");
  return { repo, pluginRoot };
}

async function main(): Promise<void> {
  console.log("smoke-gc-autotrigger — start");
  const { repo, pluginRoot } = makeRepo();

  const recorded: GcAutotriggerArgv[] = [];
  const recorder = (argv: GcAutotriggerArgv): void => {
    recorded.push(argv);
  };
  const baseTime = new Date("2026-05-01T00:00:00.000Z");

  header("Step 1 — first call with no marker → first_run");
  let r: GcAutotriggerResult;
  {
    r = runGcAutotriggerCheck({
      repoRoot: repo,
      now: baseTime,
      pluginRoot,
      spawner: recorder,
    });
    if (!r.triggered) fail(`expected triggered, got ${r.reason}`);
    if (r.reason !== "first_run") fail(`expected first_run, got ${r.reason}`);
    if (recorded.length !== 1) fail(`expected 1 spawn, got ${recorded.length}`);
    pass(`first_run trigger; argv recorded`);
  }

  header("Step 2 — argv shape: node + cli.mjs + gc sweep --repo-root");
  {
    const argv = recorded[0]!;
    if (!argv.cmd.endsWith("node") && argv.cmd !== process.execPath) {
      fail(`cmd not node-ish: ${argv.cmd}`);
    }
    if (!argv.args.some((a) => a.endsWith("cli.mjs"))) fail("args missing cli.mjs");
    if (!argv.args.includes("gc")) fail("args missing gc");
    if (!argv.args.includes("sweep")) fail("args missing sweep");
    if (!argv.args.includes("--repo-root")) fail("args missing --repo-root");
    if (!argv.args.includes(repo)) fail("args missing repoRoot value");
    if (argv.cwd !== repo) fail(`cwd ${argv.cwd} !== ${repo}`);
    pass("argv shape correct");
  }

  header("Step 3 — marker stamped with current ISO");
  {
    const markerPath = resolve(repo, ".cairn/.gc-last-run");
    if (!existsSync(markerPath)) fail("marker not written");
    const raw = readFileSync(markerPath, "utf8").trim();
    if (raw !== baseTime.toISOString()) fail(`marker content ${raw}`);
    pass("marker contains baseTime ISO");
  }

  header("Step 4 — within-threshold call is suppressed");
  {
    const oneHourLater = new Date(baseTime.getTime() + 3_600_000);
    r = runGcAutotriggerCheck({
      repoRoot: repo,
      now: oneHourLater,
      pluginRoot,
      spawner: recorder,
    });
    if (r.triggered) fail(`expected suppressed, got triggered`);
    if (r.reason !== "fresh") fail(`expected fresh, got ${r.reason}`);
    if (recorded.length !== 1) fail(`expected no new spawn, got ${recorded.length}`);
    pass("within-threshold → fresh");
  }

  header("Step 5 — past-threshold call triggers");
  {
    const past24h = new Date(baseTime.getTime() + 24 * 3_600_000 + 60_000);
    r = runGcAutotriggerCheck({
      repoRoot: repo,
      now: past24h,
      pluginRoot,
      spawner: recorder,
    });
    if (!r.triggered) fail(`expected triggered, got ${r.reason}`);
    if (r.reason !== "threshold_passed") fail(`expected threshold_passed, got ${r.reason}`);
    if (recorded.length !== 2) fail(`expected 2 spawns, got ${recorded.length}`);
    pass("threshold_passed trigger");
  }

  header("Step 6 — custom thresholdHours respected");
  {
    // Marker now sits at baseTime + 24h + 1min (set in step 5). Pick `now`
    // 2 hours past the marker so a 1-hour threshold fires.
    const twoHoursPastMarker = new Date(baseTime.getTime() + 24 * 3_600_000 + 60_000 + 2 * 3_600_000);
    r = runGcAutotriggerCheck({
      repoRoot: repo,
      now: twoHoursPastMarker,
      thresholdHours: 1,
      pluginRoot,
      spawner: recorder,
    });
    if (!r.triggered) fail(`1h threshold should fire 2h past marker, got ${r.reason}`);
    if (r.reason !== "threshold_passed") fail(`expected threshold_passed, got ${r.reason}`);
    pass("thresholdHours=1 triggers when marker is 2h old");
  }

  header("Step 7 — no CLAUDE_PLUGIN_ROOT → no_plugin_root");
  {
    rmSync(resolve(repo, ".cairn/.gc-last-run"));
    r = runGcAutotriggerCheck({
      repoRoot: repo,
      now: baseTime,
      pluginRoot: "",
      spawner: recorder,
    });
    if (r.triggered) fail("should not trigger without plugin root");
    if (r.reason !== "no_plugin_root") fail(`expected no_plugin_root, got ${r.reason}`);
    pass("missing plugin root → no_plugin_root");
  }

  header("Step 8 — plugin root without dist/cli.mjs → no_cli_bundle");
  {
    const emptyPlugin = mkdtempSync(join(tmpdir(), "cairn-smoke-gc-empty-plugin-"));
    cleanups.push(emptyPlugin);
    r = runGcAutotriggerCheck({
      repoRoot: repo,
      now: baseTime,
      pluginRoot: emptyPlugin,
      spawner: recorder,
    });
    if (r.triggered) fail("should not trigger without cli bundle");
    if (r.reason !== "no_cli_bundle") fail(`expected no_cli_bundle, got ${r.reason}`);
    pass("missing cli bundle → no_cli_bundle");
  }

  console.log("smoke-gc-autotrigger — pass");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
