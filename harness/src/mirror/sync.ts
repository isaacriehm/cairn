import { simpleGit } from "simple-git";
import { logger } from "../logger.js";
import { readMirrorRecord, requireMirrorRecord, writeMirrorRecord } from "./state.js";
import type { SyncOptions, SyncResult } from "./types.js";

const log = logger("mirror.sync");

/**
 * Pins the mirror to origin/<branch> via fetch + reset --hard. Caller is
 * responsible for ensuring no in-flight task is touching the mirror — the
 * orchestrator gates this on the FIFO queue idle state.
 *
 * Returns the SHA pin captured immediately after the reset.
 */
export async function syncMirror(opts: SyncOptions): Promise<SyncResult> {
  const record = requireMirrorRecord(opts.projectName);
  const branch = opts.branch ?? record.defaultBranch;
  const repo = simpleGit(record.mirrorPath);

  log.info({ projectName: opts.projectName, branch }, "fetching origin");
  await repo.fetch("origin");

  log.info({ projectName: opts.projectName, target: `origin/${branch}` }, "hard-resetting mirror");
  await repo.reset(["--hard", `origin/${branch}`]);

  const sha = (await repo.revparse(["HEAD"])).trim();
  const syncedAt = new Date().toISOString();

  // Re-read in case another process wrote in parallel; merge sync fields only.
  const fresh = readMirrorRecord(opts.projectName) ?? record;
  writeMirrorRecord({
    ...fresh,
    defaultBranch: fresh.defaultBranch === branch ? fresh.defaultBranch : fresh.defaultBranch,
    lastSyncedAt: syncedAt,
    lastSha: sha,
  });

  log.info({ projectName: opts.projectName, sha, branch }, "sync complete");
  return { sha, branch, syncedAt };
}
