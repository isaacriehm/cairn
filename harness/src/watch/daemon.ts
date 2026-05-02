import chokidar, { type FSWatcher } from "chokidar";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { logger } from "../logger.js";
import { projectStatePath } from "../mirror/index.js";
import type { Profile } from "../profiles/index.js";
import { selectProfile } from "../profiles/index.js";
import { regenerateAll } from "./regenerate.js";

const log = logger("watch.daemon");

export interface DaemonOptions {
  projectName: string;
  repoRoot: string;
  /** Debounce milliseconds before triggering regen (default 500). */
  debounceMs?: number;
  /** Override profile (default: detected from repo). */
  profile?: Profile;
  /** Disable PID file (used by tests). */
  noPidFile?: boolean;
}

export interface DaemonHandle {
  watcher: FSWatcher;
  /** Force a regen immediately (ignores debounce). Resolves when complete. */
  flush: () => Promise<void>;
  /** Stop the watcher and remove the PID file. */
  stop: () => Promise<void>;
}

export function pidFilePath(projectName: string): string {
  return resolve(projectStatePath(projectName), "watch.pid");
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const { projectName, repoRoot } = opts;
  const debounceMs = opts.debounceMs ?? 500;
  const profile = opts.profile ?? selectProfile(repoRoot);

  if (opts.noPidFile !== true) {
    writePidFile(projectName);
  }

  log.info(
    { projectName, repoRoot, profile: profile.id, debounceMs },
    "daemon starting",
  );

  // Initial sweep so manifest exists before any change events.
  await regenerateAll({ repoRoot, profile });

  const watcher = chokidar.watch(repoRoot, {
    ignored: (path) => isIgnored(path, repoRoot),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
  });

  let pendingChanges = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const fire = async (): Promise<void> => {
    timer = null;
    if (inFlight) {
      // Coalesce: if a regen is in flight, wait then re-fire if more accumulated.
      await inFlight;
      if (pendingChanges.size === 0) return;
    }
    const changedFiles = [...pendingChanges];
    pendingChanges = new Set();
    inFlight = (async (): Promise<void> => {
      try {
        await regenerateAll({ repoRoot, profile, changedFiles });
      } catch (err) {
        log.error({ err: String(err) }, "regenerate failed");
      }
    })();
    await inFlight;
    inFlight = null;
  };

  const onChange = (path: string): void => {
    const rel = relative(repoRoot, path).replace(/\\/g, "/");
    if (rel === "" || rel.startsWith("..")) return;
    pendingChanges.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void fire();
    }, debounceMs);
  };

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("unlink", onChange);

  const handle: DaemonHandle = {
    watcher,
    flush: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await fire();
    },
    stop: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
      if (opts.noPidFile !== true) {
        const path = pidFilePath(projectName);
        if (existsSync(path)) unlinkSync(path);
      }
      log.info({ projectName }, "daemon stopped");
    },
  };

  log.info({ projectName, repoRoot }, "daemon ready");
  return handle;
}

function writePidFile(projectName: string): void {
  const path = pidFilePath(projectName);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const otherPid = Number.parseInt(readFileSync(path, "utf8"), 10);
    if (Number.isFinite(otherPid) && isProcessAlive(otherPid)) {
      throw new Error(
        `harness watch already running for "${projectName}" (pid ${otherPid}). ` +
          "Stop the other process or remove the stale pid file.",
      );
    }
    // Stale — overwrite.
  }
  writeFileSync(path, String(process.pid), "utf8");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isIgnored(path: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, path).replace(/\\/g, "/");
  if (rel === "") return false;
  if (rel.startsWith("..")) return true;
  // Hot-path ignore — keep this list short. Heavier filtering in walk.ts.
  return (
    rel === ".git" ||
    rel.startsWith(".git/") ||
    rel === "node_modules" ||
    rel.startsWith("node_modules/") ||
    rel === ".pnpm-store" ||
    rel.startsWith(".pnpm-store/") ||
    rel === "dist" ||
    rel.startsWith("dist/") ||
    rel === ".next" ||
    rel.startsWith(".next/") ||
    rel === ".turbo" ||
    rel.startsWith(".turbo/") ||
    rel === ".harness/runs" ||
    rel.startsWith(".harness/runs/") ||
    rel === ".harness/inbox" ||
    rel.startsWith(".harness/inbox/") ||
    rel === ".harness/transcripts" ||
    rel.startsWith(".harness/transcripts/") ||
    rel === ".harness/staleness/log.jsonl" ||
    rel === ".harness/staleness/current.json" ||
    rel === ".harness/ground/manifest.yaml" ||
    rel === ".harness/ground/decisions/decisions.ledger.yaml" ||
    rel === ".harness/ground/invariants/invariants.ledger.yaml" ||
    rel === ".harness/ground/quality-grades.yaml"
  );
}
