/**
 * Stop-hook GC autotrigger.
 *
 * Runs at the tail of every Stop tick when no init is in flight. If the
 * last GC run is older than the threshold (default 24 h), spawns
 * `cairn gc sweep` detached so the next attention surface (or
 * operator-visible run) reflects current drift. The Stop hook does NOT
 * wait for the spawned process — it stamps the marker, fires the spawn,
 * unrefs, and returns.
 *
 * The spawned `cairn gc sweep` surfaces all detection passes through
 * `cairn-attention` for operator triage (no commit). Because the spawn
 * carries `CAIRN_GC_AUTOTRIGGERED=1`, that same process additionally
 * auto-retires the SAFE entity-orphan subset (`runEntityRetire({ apply })`,
 * canary-gated, rolled back on failure) — the one autonomous mutation in
 * the daily tick. Every other pass's proposals stay operator-driven via
 * `cairn gc run --apply-classes` until proven safe in the field.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSafe } from "@isaacriehm/cairn-state";

const MARKER_REL = ".cairn/.gc-last-run";
const DEFAULT_THRESHOLD_HOURS = 24;

export interface GcAutotriggerOptions {
  repoRoot: string;
  /** Override threshold in hours. Default 24. */
  thresholdHours?: number;
  /** Override "now"; injected by tests. */
  now?: Date;
  /**
   * Replace the actual `child_process.spawn` call. Smokes pass a
   * recorder so they can assert arguments without forking a real
   * subprocess.
   */
  spawner?: (argv: GcAutotriggerArgv) => void;
  /**
   * Override CLAUDE_PLUGIN_ROOT; defaults to process.env. Required for
   * tests that don't set the real env var.
   */
  pluginRoot?: string;
}

export interface GcAutotriggerArgv {
  cmd: string;
  args: string[];
  cwd: string;
}

export type GcAutotriggerReason =
  | "first_run"
  | "threshold_passed"
  | "fresh"
  | "no_plugin_root"
  | "no_cli_bundle";

export interface GcAutotriggerResult {
  triggered: boolean;
  reason: GcAutotriggerReason;
  thresholdHours: number;
  /** ISO timestamp of the marker as it stood before this call. "" when none. */
  lastRunIso: string;
  /** Argv that was (or would have been) spawned. Set when triggered=true. */
  spawned?: GcAutotriggerArgv;
}

export function runGcAutotriggerCheck(opts: GcAutotriggerOptions): GcAutotriggerResult {
  const thresholdHours = opts.thresholdHours ?? DEFAULT_THRESHOLD_HOURS;
  const now = opts.now ?? new Date();
  const markerAbs = join(opts.repoRoot, MARKER_REL);

  const prior = readMarkerMtime(markerAbs);
  let triggered = false;
  let reason: GcAutotriggerReason;
  if (prior === null) {
    triggered = true;
    reason = "first_run";
  } else if (now.getTime() - prior.getTime() >= thresholdHours * 3_600_000) {
    triggered = true;
    reason = "threshold_passed";
  } else {
    triggered = false;
    reason = "fresh";
  }

  const lastRunIso = prior ? prior.toISOString() : "";
  if (!triggered) return { triggered, reason, thresholdHours, lastRunIso };

  const pluginRoot = opts.pluginRoot ?? process.env["CLAUDE_PLUGIN_ROOT"];
  if (typeof pluginRoot !== "string" || pluginRoot.length === 0) {
    return { triggered: false, reason: "no_plugin_root", thresholdHours, lastRunIso };
  }
  const cliPath = join(pluginRoot, "dist", "cli.mjs");
  if (!existsSync(cliPath)) {
    return { triggered: false, reason: "no_cli_bundle", thresholdHours, lastRunIso };
  }

  writeFileSafe(markerAbs, now.toISOString());

  const argv: GcAutotriggerArgv = {
    cmd: process.execPath,
    args: [cliPath, "gc", "sweep", "--repo-root", opts.repoRoot],
    cwd: opts.repoRoot,
  };

  if (opts.spawner) {
    opts.spawner(argv);
  } else {
    const child: ChildProcess = spawn(argv.cmd, argv.args, {
      cwd: argv.cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CAIRN_GC_AUTOTRIGGERED: "1" },
    });
    child.unref();
  }

  return { triggered, reason, thresholdHours, lastRunIso, spawned: argv };
}

function readMarkerMtime(absPath: string): Date | null {
  if (!existsSync(absPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8").trim();
  } catch {
    return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
}
