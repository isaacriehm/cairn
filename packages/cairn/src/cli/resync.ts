/**
 * `cairn resync` — resolve surfaced config drift into config.yaml edits.
 *
 *   resync [--repo-root <path>] [--area <dir>] [--apply] [--json]
 *   resync --recluster [--apply] [--json]
 *
 * Dry-run by default (prints the proposed edits, mutates nothing). `--apply`
 * archives the pre-resync config to `.cairn/ground/.archive/`, writes the edits
 * (comment-preserving), and is idempotent. The result is a review-class change
 * to committed config the operator commits.
 *
 * `--recluster` runs the LLM half instead: re-walk prose, Haiku-judge new
 * semantic collisions, rebuild the (gitignored, per-clone) topic-index +
 * anchor-map. Spends Haiku on genuinely-new prose only; `--apply` overwrites
 * the maps after archiving them.
 */

import { resolve } from "node:path";
import { resolveAnchorRoot, runResync, runResyncRecluster } from "@isaacriehm/cairn-core";

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

function resolveRepoRoot(flags: ParsedFlags["flags"]): string {
  const explicit = typeof flags["repo-root"] === "string" ? flags["repo-root"] : "";
  return explicit.length > 0 ? resolve(explicit) : resolveAnchorRoot(process.cwd());
}

export async function resyncCli(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const repoRoot = resolveRepoRoot(flags);
  const apply = flags["apply"] === true;
  const json = flags["json"] === true;

  if (flags["recluster"] === true) {
    const r = await runResyncRecluster({ repoRoot, dryRun: !apply });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const verb = r.applied ? "rebuilt" : "would rebuild";
    console.log(
      `cairn resync --recluster — ${verb} topic-index: ${r.topicsBefore} → ${r.topicsAfter} topics ` +
        `(${r.blockCount} blocks, ${r.judgeFresh} fresh / ${r.judgeCached} cached judge calls).`,
    );
    if (r.applied) {
      if (r.archivedMaps.length > 0) {
        console.log(`pre-resync maps archived → ${r.archivedMaps.join(", ")}`);
      }
      console.log("topic-index + anchor-map rebuilt (gitignored, per-clone — no commit needed).");
    } else {
      console.log("\npreview only — re-run with --recluster --apply to overwrite the (archived) maps.");
    }
    return;
  }

  const result = runResync({
    repoRoot,
    dryRun: !apply,
    ...(typeof flags["area"] === "string" ? { area: flags["area"] } : {}),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.proposals.length === 0) {
    console.log("cairn resync — config is in sync with the tree (nothing to propose)");
    return;
  }

  const verb = result.applied ? "applied" : "would apply";
  console.log(`cairn resync — ${result.proposals.length} config edit(s) ${verb}:`);
  for (const p of result.proposals) {
    console.log(`  ${p.detail}`);
  }
  for (const s of result.skipped) {
    console.log(`  (skipped ${s.finding} at ${s.path}: ${s.reason})`);
  }
  if (result.applied) {
    if (result.archivedConfig !== null) {
      console.log(`\npre-resync config archived → ${result.archivedConfig}`);
    }
    if (result.archivedEntities.length > 0) {
      console.log(`pre-resync entity backups: ${result.archivedEntities.length} → .cairn/ground/.archive/`);
    }
    console.log("review the diff, then commit it.");
  } else {
    console.log("\npreview only — re-run with --apply to write these edits.");
  }
}
