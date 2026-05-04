/**
 * Bypass detection — Stop hook layer that catches `git commit --no-verify`.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 1 (bypass tracking).
 *
 * The post-commit hook appends every successfully-attested SHA to
 * `.harness/.attested-commits` (gitignored, per-clone). On every Stop hook
 * we read that file + the last 5 SHAs from `git log` and surface any HEAD
 * commit that isn't in the attested set.
 *
 * Pure functions on top of git + filesystem reads. No mutation. The Stop
 * hook calls `scanBypassedCommits(repoRoot)` and renders the inline A/B/C
 * via `renderBypassHint`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BypassedCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface ScanBypassResult {
  bypassed: BypassedCommit[];
  /** Total HEAD commits inspected (≤ 5). */
  inspected: number;
  /** True when `.harness/.attested-commits` exists (even if empty). */
  attestedFileExists: boolean;
}

const HEAD_LOOKBACK = 5;

export function scanBypassedCommits(repoRoot: string): ScanBypassResult {
  if (!existsSync(join(repoRoot, ".git"))) {
    return { bypassed: [], inspected: 0, attestedFileExists: false };
  }
  const recent = readRecentHead(repoRoot);
  if (recent.length === 0) {
    return { bypassed: [], inspected: 0, attestedFileExists: false };
  }
  const attested = readAttestedCommits(repoRoot);
  const bypassed: BypassedCommit[] = [];
  for (const c of recent) {
    if (attested.has(c.sha)) continue;
    bypassed.push(c);
  }
  return {
    bypassed,
    inspected: recent.length,
    attestedFileExists: existsSync(join(repoRoot, ".harness", ".attested-commits")),
  };
}

export function renderBypassHint(bypassed: BypassedCommit[]): string {
  const lines: string[] = [];
  lines.push(
    `## Bypass detection — ${bypassed.length} commit${bypassed.length === 1 ? "" : "s"} not attested`,
  );
  lines.push("");
  lines.push(
    "The following HEAD commit" +
      (bypassed.length === 1 ? " was" : "s were") +
      " not recorded by harness's post-commit hook. Likely cause: " +
      "`git commit --no-verify` (or the hook ran before `harness join` " +
      "set `core.hooksPath`).",
  );
  lines.push("");
  for (const c of bypassed) {
    lines.push(`- \`${c.shortSha}\` — ${c.subject}`);
  }
  lines.push("");
  lines.push("Surface inline to the operator now:");
  lines.push("");
  lines.push("> Some recent commits weren't attested by harness. Pick one:");
  lines.push("> `[a]` backfill — run `harness sweep` to attest sensors retroactively");
  lines.push("> `[b]` accept — record a DEC noting the bypass + reason");
  lines.push("> `[c]` defer — keep the warning, address later");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function readRecentHead(repoRoot: string): BypassedCommit[] {
  try {
    const out = execFileSync(
      "git",
      ["log", `-n${HEAD_LOOKBACK}`, "--format=%H%x09%s"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const result: BypassedCommit[] = [];
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      const tabIdx = line.indexOf("\t");
      if (tabIdx === -1) continue;
      const sha = line.slice(0, tabIdx);
      const subject = line.slice(tabIdx + 1);
      if (sha.length < 7) continue;
      result.push({ sha, shortSha: sha.slice(0, 7), subject });
    }
    return result;
  } catch {
    return [];
  }
}

function readAttestedCommits(repoRoot: string): Set<string> {
  const path = join(repoRoot, ".harness", ".attested-commits");
  if (!existsSync(path)) return new Set();
  try {
    const body = readFileSync(path, "utf8");
    const set = new Set<string>();
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      set.add(line);
    }
    return set;
  } catch {
    return new Set();
  }
}
