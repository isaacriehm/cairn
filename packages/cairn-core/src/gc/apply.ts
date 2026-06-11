/**
 * Apply a single GcCommitProposal to the mirror checkout: write the patch
 * files, run `git add` + `git commit`, return the resulting SHA.
 *
 * The caller is responsible for filtering proposals by `class` (only safe is
 * auto-applied in v1; code is surfaced for confirm).
 *
 * No push happens here — the GC sweep + canary verification + push policy is
 * orchestrated by `runGcBatch` (sweep.ts).
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileSafe } from "@isaacriehm/cairn-state";
import { simpleGit } from "simple-git";
import type { GcCommitProposal } from "./types.js";

export interface ApplyCommitOptions {
  repoRoot: string;
  proposal: GcCommitProposal;
  /** Override the commit author (smoke convenience). */
  author?: { name: string; email: string };
}

export interface ApplyCommitResult {
  commit_sha: string;
  paths_written: string[];
  paths_deleted: string[];
}

export async function applyCommit(opts: ApplyCommitOptions): Promise<ApplyCommitResult> {
  const written: string[] = [];
  const deleted: string[] = [];

  for (const [rel, content] of Object.entries(opts.proposal.patch)) {
    const abs = resolve(opts.repoRoot, rel);
    if (content === "") {
      try {
        rmSync(abs, { force: true });
        deleted.push(rel);
      } catch {
        // file may not exist; ignore
      }
    } else {
      writeFileSafe(abs, content);
      written.push(rel);
    }
  }

  const git = simpleGit({ baseDir: opts.repoRoot });
  if (opts.author !== undefined) {
    await git.addConfig("user.name", opts.author.name, false, "local");
    await git.addConfig("user.email", opts.author.email, false, "local");
  }
  await git.add(opts.proposal.paths);
  await git.commit(opts.proposal.commit_message);
  const sha = (await git.revparse(["HEAD"])).trim();

  return {
    commit_sha: sha,
    paths_written: written,
    paths_deleted: deleted,
  };
}
