/**
 * Phase 5c — daemon autostart attempt.
 *
 * Spawns `harness daemon start --detach` (best-effort) and waits up to 1.5s
 * for the project's `status.json` to appear. Returns a summary the init
 * Phase-6 output can render. Never throws — autostart is opportunistic.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeProjectName, projectStatePath } from "../mirror/index.js";

export interface DaemonAutostartResult {
  /** True when status.json materialised within the wait window. */
  started: boolean;
  /** PID parsed out of status.json when present. */
  pid: number | null;
  /** Reason the autostart was abandoned. Null on success. */
  reason: string | null;
}

const WAIT_MS = 1_500;
const POLL_INTERVAL_MS = 100;

export async function tryStartDaemon(
  repoRoot: string,
): Promise<DaemonAutostartResult> {
  const slug = normalizeProjectName(basename(repoRoot));
  const stateDir = projectStatePath(slug);
  const statusFile = join(stateDir, "status.json");

  // Pre-existing status.json + a recent updated_at means the daemon is already
  // running. No need to spawn a duplicate.
  if (existsSync(statusFile)) {
    const pid = readPidFromState(stateDir, statusFile);
    return { started: true, pid, reason: null };
  }

  let spawnFailed: string | null = null;
  try {
    const child = spawn("harness", ["daemon", "start", "--detach"], {
      detached: true,
      stdio: "ignore",
      cwd: repoRoot,
    });
    child.on("error", (err) => {
      spawnFailed = err instanceof Error ? err.message : String(err);
    });
    child.unref();
  } catch (err) {
    spawnFailed = err instanceof Error ? err.message : String(err);
  }

  if (spawnFailed !== null) {
    return {
      started: false,
      pid: null,
      reason: `harness binary not on PATH (${spawnFailed})`,
    };
  }

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (spawnFailed !== null) {
      return { started: false, pid: null, reason: spawnFailed };
    }
    if (existsSync(statusFile)) {
      const pid = readPidFromState(stateDir, statusFile);
      return { started: true, pid, reason: null };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (spawnFailed !== null) {
    return { started: false, pid: null, reason: spawnFailed };
  }
  return {
    started: false,
    pid: null,
    reason: "status.json did not appear within 1.5s",
  };
}

function readPidFromState(stateDir: string, statusFile: string): number | null {
  // Per STATUS_LINE_SPEC §3 the daemon's PID file is `daemon.pid` next to status.json.
  const pidFile = join(stateDir, "daemon.pid");
  if (existsSync(pidFile)) {
    try {
      const txt = readFileSync(pidFile, "utf8").trim();
      const n = Number.parseInt(txt, 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // fall through
    }
  }
  // Some implementations carry pid directly in status.json under "pid".
  try {
    const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as Record<
      string,
      unknown
    >;
    const pid = parsed["pid"];
    if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) return pid;
  } catch {
    // ignore
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
