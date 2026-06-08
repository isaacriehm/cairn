/**
 * `cairn sensor-run` — the live sensor gate. Invoked by the cairn git hooks
 * (pre-commit, commit-msg) and by CI.
 *
 * Modes:
 *   --staged              pre-commit. Runs the component-registry check + the
 *                         sensor sweep (Layer A stub catalog, Layer C
 *                         structural, decision-assertions) over the STAGED
 *                         tree. Blocks the commit (exit 1) on any hard
 *                         finding; soft findings print as warnings.
 *   --diff <range>        CI. Runs the same sweep over a committed range
 *                         (e.g. `origin/main..HEAD`). Report-only unless
 *                         `--strict` is also passed.
 *   --strict             with --diff: exit 1 on any hard finding.
 *   --commit-msg <path>  commit-msg hook. There are no commit-message
 *                         sensors by design, so this is an intentional clean
 *                         pass (kept so already-installed hooks don't error).
 *
 * Exits 0 on a clean tree or a repo with no component config. Exits 1 only on
 * a hard finding (component or sensor) at a blocking gate.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  getRangeDiff,
  getStagedDiff,
  runComponentCheck,
  runSensorsOnDiff,
  type SensorSweepResult,
} from "@isaacriehm/cairn-core";

type Trigger = "pre-commit" | "commit-msg" | "diff";

function findRepoRoot(start: string): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 80; i++) {
    if (existsSync(join(cur, ".cairn"))) return cur;
    const parent = resolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** Staged files (added/copied/modified/renamed), repo-relative POSIX. */
function stagedFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    ).toString("utf8");
    return out
      .split("\0")
      .filter((p) => p.length > 0)
      .map((p) => p.split("\\").join("/"));
  } catch {
    return [];
  }
}

function parseFlags(argv: string[]): {
  trigger: Trigger;
  commitMsgPath: string | null;
  diffRange: string | null;
  strict: boolean;
} | null {
  let trigger: Trigger | null = null;
  let commitMsgPath: string | null = null;
  let diffRange: string | null = null;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged") {
      trigger = "pre-commit";
    } else if (a === "--strict") {
      strict = true;
    } else if (a === "--diff") {
      trigger = "diff";
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        diffRange = next;
        i += 1;
      }
    } else if (a === "--commit-msg") {
      trigger = "commit-msg";
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        commitMsgPath = next;
        i += 1;
      }
    }
  }
  if (trigger === null) return null;
  return { trigger, commitMsgPath, diffRange, strict };
}

/** Print every sensor finding, ERROR for hard / WARN for soft. */
function printFindings(sweep: SensorSweepResult): void {
  for (const r of sweep.results) {
    for (const f of r.findings) {
      const tag = f.severity === "hard" ? "ERROR" : "WARN ";
      console.error(`${tag} ${f.sensor_id}: ${f.message}`);
    }
  }
}

export async function sensorRunCli(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (flags === null) {
    console.error(
      "Usage: cairn sensor-run --staged | --diff <range> [--strict] | --commit-msg <path>\n" +
        "Invoked by the cairn pre-commit / commit-msg git hooks and by CI.",
    );
    process.exit(2);
  }

  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === null) {
    // Not a cairn-adopted repo — hooks call us defensively, exit clean.
    process.exit(0);
  }

  // commit-msg: no commit-message sensors by design — clean pass.
  if (flags.trigger === "commit-msg") {
    process.exit(0);
  }

  // ── CI diff sweep ─────────────────────────────────────────────────────
  if (flags.trigger === "diff") {
    const range = flags.diffRange ?? "origin/main..HEAD";
    const diff = await getRangeDiff(repoRoot, range);
    const sweep = await runSensorsOnDiff({ repoRoot, diff, runId: `ci:${range}` });
    printFindings(sweep);
    if (sweep.hard_failures > 0 && flags.strict) {
      console.error(
        `\nCairn sensor sweep FAILED — ${sweep.hard_failures} hard finding(s) over ${range}.`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  // ── pre-commit: component check + sensor sweep on the staged tree ──────
  const staged = stagedFiles(repoRoot);
  const componentResult = runComponentCheck(repoRoot, { files: staged });

  let hardFailures = componentResult.hardFailures;
  for (const f of componentResult.findings) {
    const tag = f.severity === "hard" ? "ERROR" : "WARN ";
    console.error(`${tag} component: ${f.message}`);
  }

  const stagedDiff = await getStagedDiff(repoRoot);
  const sweep = await runSensorsOnDiff({
    repoRoot,
    diff: stagedDiff,
    runId: "pre-commit",
  });
  printFindings(sweep);
  hardFailures += sweep.hard_failures;

  if (hardFailures > 0) {
    console.error(
      `\nCairn pre-commit gate FAILED — ${hardFailures} hard finding(s). ` +
        "Fix them, then re-commit (or `git commit --no-verify` to bypass; " +
        "the bypass is flagged at the next session and caught by CI).",
    );
    process.exit(1);
  }

  // soft-only — surfaced as warnings above, don't block.
  process.exit(0);
}
