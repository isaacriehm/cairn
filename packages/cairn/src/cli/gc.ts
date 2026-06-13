/**
 * `cairn gc` — garbage-collection CLI.
 *
 * Subcommands:
 *   sweep [--repo-root <path>] [--json]
 *     Run all five passes; print findings + proposals; never commit.
 *
 *   run   [--repo-root <path>] [--apply-classes safe[,code]]
 *         [--no-canary] [--no-quality] [--force-frontmatter-refresh] [--json]
 *     Sweep, then apply proposals whose class is in --apply-classes (default
 *     "safe"). Canary on by default. Push is NEVER done by this command —
 *     the operator pushes via `cairn mirror push` after auditing the local
 *     commits.
 *
 *   retire [--repo-root <path>] [--apply] [--no-canary] [--json]
 *     Run the entity-orphan pass and archive the SAFE subset (provably
 *     orphaned DEC/INV). Surface-only without --apply. Ambiguous orphans
 *     always surface for triage; they are never auto-retired.
 */

import { resolve } from "node:path";
import {
  archiveEntity,
  resolveAnchorRoot,
  runEntityRetire,
  runGcBatch,
  runGcSweep,
  writeConfigDriftBaseline,
  type EntityRetireResult,
  type GcAutoMergeClass,
  type GcBatchResult,
  type GcSweepResult,
} from "@isaacriehm/cairn-core";

const ENTITY_ID_RE = /^(DEC|INV)-[0-9a-f]{7,}$/;

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
    "Usage: cairn gc <subcommand> [options]\n" +
      "  sweep  [--repo-root <path>] [--json]\n" +
      "  run    [--repo-root <path>] [--apply-classes safe[,code]]\n" +
      "         [--no-canary] [--force-frontmatter-refresh] [--json]\n" +
      "  retire [--repo-root <path>] [--apply] [--no-canary] [--json]\n",
  );
  process.exit(1);
}

function resolveRepoRoot(flags: ParsedFlags["flags"]): string {
  const explicit = typeof flags["repo-root"] === "string" ? flags["repo-root"] : "";
  // Explicit --repo-root wins; otherwise anchor at the adopted/git root,
  // never the launch subdir (so `cairn gc …` from a package dir still
  // targets the one repo-root `.cairn/`).
  return explicit.length > 0 ? resolve(explicit) : resolveAnchorRoot(process.cwd());
}

function parseApplyClasses(value: unknown): readonly GcAutoMergeClass[] {
  if (typeof value !== "string" || value.length === 0) return ["safe"];
  const out: GcAutoMergeClass[] = [];
  for (const raw of value.split(",")) {
    const v = raw.trim();
    if (v === "safe" || v === "code") out.push(v);
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
      // The autonomous daily tick (Stop-hook autotrigger spawns this with
      // CAIRN_GC_AUTOTRIGGERED=1) also retires the SAFE orphan subset —
      // the one autonomous mutation in the tick. A manual `cairn gc sweep`
      // stays strictly read-only.
      let retire: EntityRetireResult | null = null;
      if (process.env["CAIRN_GC_AUTOTRIGGERED"] === "1") {
        retire = await runEntityRetire({ repoRoot, apply: true });
        // Persist config-drift findings so the cairn-attention surface picks
        // them up as `baseline_finding` items on the next session (the daily
        // tick is the surfacing path; a manual `gc sweep` stays read-only).
        writeConfigDriftBaseline(repoRoot, result.findings);
      }
      if (json) {
        console.log(
          JSON.stringify(retire !== null ? { sweep: result, retire } : result, null, 2),
        );
        return;
      }
      printSweep(result);
      if (retire !== null) printRetire(retire, true);
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
    case "retire": {
      const repoRoot = resolveRepoRoot(flags);
      const apply = flags["apply"] === true;

      // Single-id mode: `cairn gc retire DEC-abc1234 [--apply]` archives one
      // explicit entity (terminal/debug path), bypassing the orphan pass.
      const explicitId = positional[1];
      if (typeof explicitId === "string" && ENTITY_ID_RE.test(explicitId)) {
        if (!apply) {
          console.log(`would retire ${explicitId} (pass --apply to archive it)`);
          return;
        }
        const res = archiveEntity({
          repoRoot,
          id: explicitId,
          reason: "manual retire via cairn gc retire",
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(
          res.ok
            ? `retired ${res.id} (${res.kind}) → ${res.archivedPath}`
            : `retire failed for ${explicitId}: ${res.error ?? "unknown error"}`,
        );
        return;
      }

      const result = await runEntityRetire({
        repoRoot,
        apply,
        canary: flags["no-canary"] !== true,
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printRetire(result, apply);
      return;
    }
    default:
      usage();
  }
}

function printSweep(result: GcSweepResult): void {
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

function printBatch(result: GcBatchResult): void {
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

function printRetire(result: EntityRetireResult, applied: boolean): void {
  const safeCount = result.retired.length + result.surfaced.length;
  console.log(
    `gc retire — ${result.retired.length} retired, ${result.surfaced.length} safe-surfaced, ${result.ambiguous.length} ambiguous` +
      (applied ? ` · canary ${result.canary_ok ? "ok" : "FAIL"}${result.rolled_back ? " (rolled back)" : ""}` : " (surface-only; pass --apply to retire)"),
  );
  for (const r of result.retired) {
    console.log(`  retired ${r.id} (${r.kind}) → ${r.archivedPath}`);
  }
  if (!applied && safeCount > 0) {
    console.log("\nSafe orphans (would retire with --apply):");
    for (const s of result.surfaced) console.log(`  ${s.id} (${s.kind}) — ${s.reason}`);
  }
  if (result.ambiguous.length > 0) {
    console.log("\nAmbiguous (manual review — never auto-retired):");
    for (const a of result.ambiguous) console.log(`  ${a.id} (${a.kind}) — ${a.reason}`);
  }
  if (result.rolled_back) {
    console.log("\nCanary failures (batch rolled back):");
    for (const f of result.canary_failures) console.log(`  - ${f}`);
  }
}
