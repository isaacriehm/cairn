/**
 * `harness gc` — garbage-collection CLI.
 *
 * Subcommands:
 *   sweep [--repo-root <path>] [--json]
 *     Run all five passes; print findings + proposals; never commit.
 *
 *   run   [--repo-root <path>] [--apply-classes safe[,code[,high-stakes]]]
 *         [--no-canary] [--no-quality] [--force-frontmatter-refresh] [--json]
 *     Sweep, then apply proposals whose class is in --apply-classes (default
 *     "safe"). Canary on by default. Push is NEVER done by this command —
 *     the operator pushes via `harness mirror push` after auditing the local
 *     commits.
 */

import { resolve } from "node:path";
import { runGcBatch, runGcSweep } from "../gc/index.js";
import type { GcAutoMergeClass } from "../gc/types.js";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.error(
    "Usage: harness gc <subcommand> [options]\n" +
      "  sweep  [--repo-root <path>] [--json]\n" +
      "  run    [--repo-root <path>] [--apply-classes safe[,code[,high-stakes]]]\n" +
      "         [--no-canary] [--force-frontmatter-refresh] [--json]\n",
  );
  process.exit(1);
}

function resolveRepoRoot(flags: ParsedFlags["flags"]): string {
  const explicit = typeof flags["repo-root"] === "string" ? flags["repo-root"] : "";
  return resolve(explicit.length > 0 ? explicit : process.cwd());
}

function parseApplyClasses(value: unknown): readonly GcAutoMergeClass[] {
  if (typeof value !== "string" || value.length === 0) return ["safe"];
  const out: GcAutoMergeClass[] = [];
  for (const raw of value.split(",")) {
    const v = raw.trim();
    if (v === "safe" || v === "code" || v === "high-stakes") out.push(v);
  }
  return out.length > 0 ? out : ["safe"];
}

export async function gcCli(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const sub = positional[0];
  const json = flags["json"] === true;

  switch (sub) {
    case "sweep": {
      const repoRoot = resolveRepoRoot(flags);
      const result = await runGcSweep({
        repoRoot,
        ...(flags["force-frontmatter-refresh"] === true
          ? { frontmatter: { forceRefresh: true } }
          : {}),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printSweep(result);
      return;
    }
    case "run": {
      const repoRoot = resolveRepoRoot(flags);
      const applyClasses = parseApplyClasses(flags["apply-classes"]);
      const canary = flags["no-canary"] !== true;
      const result = await runGcBatch({
        repoRoot,
        applyClasses,
        canary,
        ...(flags["force-frontmatter-refresh"] === true
          ? { frontmatter: { forceRefresh: true } }
          : {}),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printBatch(result);
      return;
    }
    default:
      usage();
  }
}

function printSweep(result: import("../gc/types.js").GcSweepResult): void {
  const byPass: Record<string, number> = {};
  for (const f of result.findings) byPass[f.pass] = (byPass[f.pass] ?? 0) + 1;
  console.log(`gc sweep — ${result.findings.length} findings, ${result.proposals.length} proposals`);
  for (const [pass, count] of Object.entries(byPass)) {
    const ms = result.pass_durations[pass as keyof typeof result.pass_durations] ?? 0;
    console.log(`  ${pass}: ${count} findings (${ms}ms)`);
  }
  for (const p of result.proposals) {
    console.log(
      `  proposal [${p.class}] ${p.pass} → ${p.paths.length} path${p.paths.length === 1 ? "" : "s"}: ${p.paths.join(", ")}`,
    );
  }
  if (result.findings.length > 0) {
    console.log("\nFindings:");
    for (const f of result.findings) {
      console.log(`  [${f.severity}] ${f.path}: ${f.detail}`);
    }
  }
}

function printBatch(result: import("../gc/types.js").GcBatchResult): void {
  console.log(
    `gc run — ${result.applied.length} applied, ${result.surfaced.length} surfaced, canary ${result.canary_ok ? "ok" : "FAIL"}${result.rolled_back ? " (rolled back)" : ""}`,
  );
  for (const a of result.applied) {
    console.log(
      `  applied [${a.class}] ${a.pass} ${a.commit_sha.slice(0, 7)} — ${a.paths.join(", ")}`,
    );
  }
  for (const s of result.surfaced) {
    console.log(
      `  surfaced [${s.class}] ${s.pass} → ${s.paths.join(", ")} (review + apply manually)`,
    );
  }
  if (!result.canary_ok) {
    console.log("\nCanary failures:");
    for (const f of result.canary_failures) console.log(`  - ${f}`);
  }
}
