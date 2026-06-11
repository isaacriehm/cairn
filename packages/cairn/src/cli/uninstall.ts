/**
 * `cairn uninstall` — remove Cairn from a repo.
 *
 * Destructive, so it is dry-run by default: with no `--yes` it prints the
 * plan and changes nothing. `--yes` applies it.
 *
 *   --yes          apply (otherwise dry-run / preview only)
 *   --keep-cites   leave in-source §DEC-/§INV- tokens (they will dangle)
 *   --repo <path>  operate on another repo root
 */

import { resolve } from "node:path";
import {
  isAdopted,
  uninstallCairn,
  type UninstallResult,
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

function icon(status: UninstallResult["steps"][number]["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "warn":
      return "⚠";
    case "skipped":
      return "·";
  }
}

function render(result: UninstallResult, applied: boolean): void {
  process.stdout.write(`⬡ cairn uninstall${applied ? "" : " (preview — nothing changed)"}\n\n`);
  for (const s of result.steps) {
    process.stdout.write(`  ${icon(s.status)}  ${s.step.padEnd(16)} ${s.detail}\n`);
  }
  process.stdout.write("\n");
  if (applied) {
    process.stdout.write("  Cairn removed. Source kept any inlined decision/invariant bodies as plain comments.\n");
  } else {
    process.stdout.write("  Preview only. Re-run with --yes to apply.\n");
  }
}

export async function uninstallCli(argv: string[]): Promise<void> {
  const repoRoot = parseRepoFlag(argv);
  if (!isAdopted(repoRoot)) {
    console.error(
      `cairn: ${repoRoot} is not cairn-adopted (no config.yaml). Nothing to uninstall.`,
    );
    process.exit(2);
  }

  const apply = argv.includes("--yes") || argv.includes("-y");
  const keepCites = argv.includes("--keep-cites");

  const result = uninstallCairn({
    repoRoot,
    expandCites: !keepCites,
    dryRun: !apply,
  });
  render(result, apply);
  process.exit(0);
}
