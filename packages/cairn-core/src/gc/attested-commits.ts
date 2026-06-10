/**
 * GC Pass — Prune .attested-commits.
 *
 * Keeps the last 100 entries in .cairn/.attested-commits to prevent
 * unbounded growth of the bypass-detection log. This is a local-only
 * cleanup (file is gitignored).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { GcFinding, GcCommitProposal } from "./types.js";
import { cairnDir } from "@isaacriehm/cairn-state";

export interface AttestedCommitsGcOptions {
  repoRoot: string;
  /** Number of entries to keep. Default 100. */
  keepCount?: number;
}

export interface AttestedCommitsGcResult {
  findings: GcFinding[];
  /** This pass never proposes a commit as the file is gitignored. */
  proposals: GcCommitProposal[];
}

const DEFAULT_KEEP = 100;

export function runAttestedCommitsGc(
  opts: AttestedCommitsGcOptions,
): AttestedCommitsGcResult {
  const keep = opts.keepCount ?? DEFAULT_KEEP;
  const path = cairnDir(opts.repoRoot, ".attested-commits");
  if (!existsSync(path)) {
    return { findings: [], proposals: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { findings: [], proposals: [] };
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= keep) {
    return { findings: [], proposals: [] };
  }

  const pruned = lines.slice(-keep);
  try {
    writeFileSync(path, pruned.join("\n") + "\n", "utf8");
  } catch {
    return { findings: [], proposals: [] };
  }

  return {
    findings: [
      {
        pass: "attested-commits-pruning",
        kind: "orphan_path", // closest fit for "local file maintenance"
        path: ".cairn/.attested-commits",
        detail: `Pruned attested-commits log (kept last ${keep} SHAs)`,
        severity: "info",
      },
    ],
    proposals: [],
  };
}
