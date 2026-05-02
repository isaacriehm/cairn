import { simpleGit } from "simple-git";
import { logger } from "../logger.js";
import { requireMirrorRecord } from "./state.js";
import type { PushOptions, PushResult } from "./types.js";

const log = logger("mirror.push");

/**
 * Pushes the mirror's current HEAD to origin. Caller commits first.
 *
 * Force pushes are refused unless `force: true` is explicitly set; the only
 * time the harness sets that is during recovery flows that have explicit
 * operator authorization. Routine pushes never force.
 */
export async function pushMirror(opts: PushOptions): Promise<PushResult> {
  const record = requireMirrorRecord(opts.projectName);
  const branch = opts.branch ?? record.defaultBranch;
  const repo = simpleGit(record.mirrorPath);

  const sha = (await repo.revparse(["HEAD"])).trim();
  log.info({ projectName: opts.projectName, branch, sha, force: opts.force === true }, "pushing");

  const args = ["origin", branch];
  if (opts.force === true) args.unshift("--force-with-lease");

  const result = await repo.push(args);
  const pushedAt = new Date().toISOString();
  const raw = JSON.stringify(result);

  log.info({ projectName: opts.projectName, branch, sha }, "push complete");
  return { sha, branch, pushedAt, raw };
}
