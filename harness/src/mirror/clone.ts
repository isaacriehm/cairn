import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { simpleGit } from "simple-git";
import { logger } from "../logger.js";
import { mirrorPath, reposRoot } from "./paths.js";
import { readMirrorRecord, writeMirrorRecord } from "./state.js";
import type { CloneOptions, MirrorRecord } from "./types.js";

const log = logger("mirror.clone");

/**
 * Idempotent: ensures the mirror exists for the given project. Records the
 * record if missing. Returns the (possibly-updated) record.
 */
export async function ensureMirror(opts: CloneOptions): Promise<MirrorRecord> {
  const { projectName, userTreePath, originUrl } = opts;
  const path = mirrorPath(projectName);

  const existing = readMirrorRecord(projectName);
  if (existing && existsSync(path)) {
    log.debug({ projectName, path }, "mirror already present");
    if (existing.originUrl !== originUrl || existing.userTreePath !== userTreePath) {
      throw new Error(
        `Mirror record for "${projectName}" exists with different origin/userTreePath.\n` +
          `  recorded:  ${existing.originUrl} (tree ${existing.userTreePath})\n` +
          `  requested: ${originUrl} (tree ${userTreePath})\n` +
          "Refusing to overwrite. Resolve manually before re-running.",
      );
    }
    return existing;
  }

  log.info({ projectName, originUrl, path }, "cloning mirror");
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(reposRoot(), { recursive: true });

  const git = simpleGit();
  await git.clone(originUrl, path);

  const repo = simpleGit(path);
  const branchSummary = await repo.branch();
  const defaultBranch = opts.defaultBranch ?? branchSummary.current;

  const record: MirrorRecord = {
    projectName,
    userTreePath,
    originUrl,
    defaultBranch,
    mirrorPath: path,
    lastSyncedAt: null,
    lastSha: null,
    createdAt: new Date().toISOString(),
  };
  writeMirrorRecord(record);
  log.info({ projectName, defaultBranch }, "mirror clone complete");
  return record;
}
