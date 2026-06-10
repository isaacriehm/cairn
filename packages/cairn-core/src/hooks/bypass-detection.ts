/**
 * Bypass detection — Stop hook layer that catches `git commit --no-verify`.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 1 (bypass tracking).
 *
 * The post-commit hook appends every successfully-attested SHA to
 * `.cairn/.attested-commits` (gitignored, per-clone). On every Stop hook
 * we read that file + the last 5 SHAs from `git log` and surface any HEAD
 * commit that isn't in the attested set.
 *
 * Multi-dev correctness: `.attested-commits` is per-clone, so a teammate's
 * commit pulled into this clone is never in our local attested set. To
 * avoid flagging every pulled commit as a bypass, we only inspect commits
 * NOT yet reachable from any remote (`git log HEAD --not --remotes`) —
 * i.e. local, unpushed work. Anything already on a remote was gated by CI
 * (and attested on whatever clone authored it), so it's not a local
 * bypass. Solo repos with no remote degrade to "inspect recent HEAD".
 *
 * Pure functions on top of git + filesystem reads. No mutation. The Stop
 * hook calls `scanBypassedCommits(repoRoot)` and renders the inline A/B/C
 * via `renderBypassHint`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";

export interface BypassedCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface ScanBypassResult {
  bypassed: BypassedCommit[];
  /** Total HEAD commits inspected (≤ 5). */
  inspected: number;
  /** True when `.cairn/.attested-commits` exists (even if empty). */
  attestedFileExists: boolean;
}

const HEAD_LOOKBACK = 5;
const NUL = "\x00";

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
    attestedFileExists: existsSync(cairnDir(repoRoot, ".attested-commits")),
  };
}

export function renderBypassHint(bypassed: BypassedCommit[]): string {
  const lines: string[] = [];
  const noun = bypassed.length === 1 ? "commit" : "commits";
  lines.push(
    `## Cairn — ${bypassed.length} ${noun} not attested`,
  );
  lines.push("");
  lines.push(
    "Reached HEAD without a matching entry in `.cairn/.attested-commits`. Likely cause is one of:",
  );
  lines.push("");
  lines.push(
    "- `git commit --no-verify` (post-commit hook skipped)",
  );
  lines.push(
    "- per-clone bootstrap not yet run on this checkout (`.attested-commits` missing or stale)",
  );
  lines.push(
    "- commits pre-date current adoption (operator can `bypass-accept` to seed)",
  );
  lines.push("");
  for (const c of bypassed) {
    lines.push(`- \`${c.shortSha}\` — ${c.subject}`);
  }
  lines.push("");
  lines.push(
    "Invoke the `cairn-attention` skill on the next turn so the operator can pick record bypass / acknowledge / defer through `AskUserQuestion`.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function readRecentHead(repoRoot: string): BypassedCommit[] {
  try {
    // NUL (%x00) as the SHA/subject separator. Tabs and any other
    // printable byte can legitimately appear inside a commit subject;
    // NUL cannot. Records are newline-separated; the subject (`%s`) is
    // a single line by definition, so split("\n") is safe.
    //
    // `HEAD --not --remotes` restricts to commits not yet on any remote —
    // local, unpushed work. Pulled teammate commits live on origin and are
    // excluded, so the per-clone `.attested-commits` never false-flags
    // them. With no remote configured, `--remotes` expands to nothing and
    // this is equivalent to plain `git log -n5` (solo behavior preserved).
    const out = execFileSync(
      "git",
      ["log", `-n${HEAD_LOOKBACK}`, "--format=%H%x00%s", "HEAD", "--not", "--remotes"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const result: BypassedCommit[] = [];
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      const sepIdx = line.indexOf(NUL);
      if (sepIdx === -1) continue;
      const sha = line.slice(0, sepIdx);
      const subject = line.slice(sepIdx + 1);
      if (sha.length < 7) continue;
      result.push({ sha, shortSha: sha.slice(0, 7), subject });
    }
    return result;
  } catch {
    return [];
  }
}

function readAttestedCommits(repoRoot: string): Set<string> {
  const path = cairnDir(repoRoot, ".attested-commits");
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
