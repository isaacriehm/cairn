/**
 * `cairn cites <sub>` — citation tooling.
 *
 *   expand  replace `// §DEC-<hash>` / `// §INV-<hash>` citation lines with
 *           the entity's body inline, as a plain comment in the file's own
 *           comment style. The inverse of sot-align's strip-replace — used
 *           to un-cite a repo so removing `.cairn/` leaves self-documenting
 *           source.
 *
 *           [file...]   expand only these files (repo-relative or absolute)
 *           (no files)  expand every cited file in the scope-index
 *           --dry-run   report what would change; write nothing
 *           --repo <p>  operate on another repo root
 */

import { relative, resolve } from "node:path";
import {
  expandCitesInRepo,
  isAdopted,
  type ExpandCitesRepoResult,
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
    "Usage: cairn cites expand [file...] [--dry-run] [--repo <path>]\n" +
      "  expand  inline DEC/INV citation bodies as plain comments\n" +
      "          (no files → every cited file in the scope-index)\n" +
      "          --dry-run  report changes, write nothing",
  );
  process.exit(2);
}

function render(result: ExpandCitesRepoResult, dryRun: boolean): void {
  const verb = dryRun ? "would expand" : "expanded";
  process.stdout.write(`⬡ cairn cites expand${dryRun ? " (dry-run)" : ""}\n\n`);
  if (result.files.length === 0) {
    process.stdout.write("  ✓ no citations found.\n");
    return;
  }
  for (const f of result.files) {
    const bits = [`${f.expanded} expanded`];
    if (f.danglingSkipped > 0) bits.push(`${f.danglingSkipped} dangling`);
    if (f.inlineSkipped > 0) bits.push(`${f.inlineSkipped} inline-skipped`);
    process.stdout.write(`    ${f.filePath}  (${bits.join(", ")})\n`);
  }
  process.stdout.write(
    `\n  ${verb} ${result.expanded} citation${result.expanded === 1 ? "" : "s"} across ` +
      `${result.filesChanged} file${result.filesChanged === 1 ? "" : "s"}.\n`,
  );
  if (result.danglingSkipped > 0) {
    process.stdout.write(
      `  ${result.danglingSkipped} dangling citation(s) left in place — entity not on disk.\n`,
    );
  }
  if (result.inlineSkipped > 0) {
    process.stdout.write(
      `  ${result.inlineSkipped} citation(s) sharing a line with code left in place.\n`,
    );
  }
  if (dryRun) process.stdout.write("\n  Dry run — re-run without --dry-run to apply.\n");
}

export async function citesCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "expand") usage();

  const rest = argv.slice(1);
  const repoRoot = parseRepoFlag(rest);
  if (!isAdopted(repoRoot)) {
    console.error(
      `cairn: ${repoRoot} is not cairn-adopted (no config.yaml). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }

  const dryRun = rest.includes("--dry-run");
  // Positional file args = anything that isn't a flag or the --repo value.
  const repoIdx = rest.indexOf("--repo");
  const fileArgs = rest.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (repoIdx !== -1 && i === repoIdx + 1) return false; // the --repo path
    return true;
  });

  const files =
    fileArgs.length > 0
      ? fileArgs.map((f) => {
          const abs = resolve(f);
          return relative(repoRoot, abs);
        })
      : undefined;

  const result = expandCitesInRepo({
    repoRoot,
    dryRun,
    ...(files !== undefined ? { files } : {}),
  });
  render(result, dryRun);
  process.exit(0);
}
