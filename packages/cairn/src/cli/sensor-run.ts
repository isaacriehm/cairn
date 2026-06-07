/**
 * `cairn sensor-run` — invoked by the cairn git hooks (pre-commit,
 * commit-msg).
 *
 * On `--staged` this runs the **component registry check** against staged
 * files and blocks the commit (exit 1) on any hard finding — missing `@cairn`
 * header, missing required tag, invalid category, or duplicate name. This is
 * the first real execution path for the pre-commit gate (it was previously a
 * no-op stub). Soft findings (export mismatch, alias collision) print as
 * warnings without blocking.
 *
 * `--commit-msg` is reserved for future commit-message sensors; it passes
 * cleanly today.
 *
 * Exits 0 on a clean tree or a repo with no component config; exits 1 only on
 * a hard component finding.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runComponentCheck } from "@isaacriehm/cairn-core";

type Trigger = "pre-commit" | "commit-msg";

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
} | null {
  let trigger: Trigger | null = null;
  let commitMsgPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged") {
      trigger = "pre-commit";
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
  return { trigger, commitMsgPath };
}

export async function sensorRunCli(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (flags === null) {
    console.error(
      "Usage: cairn sensor-run --staged | --commit-msg <path>\n" +
        "Invoked by the cairn pre-commit / commit-msg git hooks.",
    );
    process.exit(2);
  }

  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === null) {
    // Not a cairn-adopted repo — hooks call us defensively, exit clean.
    process.exit(0);
  }

  // commit-msg has no sensors wired yet — clean pass.
  if (flags.trigger === "commit-msg") {
    process.exit(0);
  }

  // ── pre-commit: component registry check on staged files ──────────────
  const staged = stagedFiles(repoRoot);
  const result = runComponentCheck(repoRoot, { files: staged });

  if (result.findings.length === 0) {
    process.exit(0);
  }

  for (const f of result.findings) {
    const tag = f.severity === "hard" ? "ERROR" : "WARN ";
    console.error(`${tag} component: ${f.message}`);
  }

  if (result.hardFailures > 0) {
    console.error(
      `\nCairn component check FAILED — ${result.hardFailures} hard finding(s). ` +
        "Fix the @cairn headers, then re-commit (or `git commit --no-verify` to bypass; " +
        "the bypass is flagged at the next session and caught by CI).",
    );
    process.exit(1);
  }

  // soft-only — surface as warnings, don't block.
  process.exit(0);
}
