/**
 * `cairn invariants <sub>` — invariant store maintenance.
 *
 *   prune   retire junk invariants the Layer A sot-align hook minted before
 *           the creation gate landed. Only `capture_source: layer-a-sot-align`
 *           invariants are eligible — curated invariants are never touched.
 *
 *           --dry-run   list what would be archived; change nothing
 *           --all       archive EVERY sot-align invariant (full reset);
 *                       default is surgical (only those with no constraint shape)
 *           --repo <p>  operate on another repo root
 */

import { resolve } from "node:path";
import {
  isAdopted,
  pruneInvariants,
  type PruneInvariantsResult,
} from "@isaacriehm/cairn-core";

function parseRepoFlag(argv: string[]): string {
  const idx = argv.indexOf("--repo");
  if (idx === -1) return process.cwd();
  const candidate = argv[idx + 1];
  if (candidate === undefined || candidate.startsWith("--")) {
    console.error("--repo requires a path argument");
    process.exit(2);
  }
  return resolve(candidate);
}

function usage(): never {
  console.error(
    "Usage: cairn invariants prune [--dry-run] [--all] [--repo <path>]\n" +
      "  prune   retire junk sot-align invariants (no constraint shape)\n" +
      "          --dry-run  list candidates, change nothing\n" +
      "          --all      archive every sot-align invariant (full reset)",
  );
  process.exit(2);
}

function renderPrune(result: PruneInvariantsResult, mode: string): void {
  const verb = result.dryRun ? "would archive" : "archived";
  process.stdout.write(`⬡ cairn invariants prune (${mode}${result.dryRun ? ", dry-run" : ""})\n\n`);
  process.stdout.write(
    `  scanned ${result.scanned} invariant${result.scanned === 1 ? "" : "s"}; ` +
      `${result.sotAlignTotal} sot-align-sourced (eligible)\n`,
  );
  if (result.pruned.length === 0) {
    process.stdout.write(`  ✓ nothing to prune — no junk sot-align invariants found.\n`);
    return;
  }
  process.stdout.write(`  ${verb} ${result.pruned.length}; kept ${result.kept}\n\n`);
  const shown = result.pruned.slice(0, 20);
  for (const p of shown) {
    const title = p.title.length > 0 ? p.title : "(untitled)";
    process.stdout.write(`    - ${p.id}  ${title}\n`);
  }
  if (result.pruned.length > shown.length) {
    process.stdout.write(`    … +${result.pruned.length - shown.length} more\n`);
  }
  if (result.citesRepaired > 0) {
    const verbCite = result.dryRun ? "would repair" : "repaired";
    process.stdout.write(
      `  ${verbCite} ${result.citesRepaired} dangling §INV cite${result.citesRepaired === 1 ? "" : "s"} ` +
        `in ${result.sourceFilesRepaired} source file${result.sourceFilesRepaired === 1 ? "" : "s"}\n`,
    );
  }
  if (!result.dryRun) {
    process.stdout.write(
      `\n  Archived to .cairn/ground/.archive/invariants/ (recoverable).\n` +
        `  Run \`cairn fix\` to refresh the scope-index + manifest.\n`,
    );
  } else {
    process.stdout.write(`\n  Dry run — re-run without --dry-run to apply.\n`);
  }
}

export async function invariantsCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "prune") usage();

  const flags = argv.slice(1);
  const repoRoot = parseRepoFlag(flags);
  if (!isAdopted(repoRoot)) {
    console.error(
      `cairn: ${repoRoot} is not cairn-adopted (no config.yaml). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }

  const dryRun = flags.includes("--dry-run");
  const mode = flags.includes("--all") ? "all" : "surgical";
  const result = pruneInvariants({ repoRoot, mode, dryRun });
  renderPrune(result, mode);
  process.exit(0);
}
