/**
 * `cairn scope <subcommand>` — scope-index commands.
 *
 *   cairn scope rebuild [--repo <path>]   — re-run mapper, rewrite scope-index.yaml
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isAdopted, rebuildScopeIndex } from "@isaacriehm/cairn-core";

function usage(): never {
  console.error(
    "Usage: cairn scope <subcommand>\n" +
      "  rebuild       re-run mapper LLM and rewrite scope-index.yaml\n" +
      "                (--repo <path>?   defaults to cwd)\n",
  );
  process.exit(1);
}

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

async function rebuildHandler(argv: string[]): Promise<void> {
  const repoRoot = parseRepoFlag(argv);
  if (!existsSync(repoRoot)) {
    console.error(`cairn scope rebuild: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }
  if (!isAdopted(repoRoot)) {
    console.error(
      `cairn scope rebuild: ${repoRoot} is not cairn-adopted (no config.yaml). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }

  process.stdout.write("⬡ cairn scope rebuild — deterministic regex rescan…\n");
  try {
    const result = await rebuildScopeIndex({ repoRoot });
    const relPath = result.path.startsWith(repoRoot)
      ? result.path.slice(repoRoot.length + 1)
      : result.path;
    process.stdout.write(
      `  ✓ wrote ${relPath} — ${result.filesClassified} file${
        result.filesClassified === 1 ? "" : "s"
      } scanned  (${result.durationMs}ms)\n`,
    );
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`cairn scope rebuild: rescan failed — ${msg}`);
    process.exit(1);
  }
}

export async function scopeCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "rebuild":
      await rebuildHandler(argv.slice(1));
      return;
    case undefined:
    default:
      console.error(`cairn scope: unknown subcommand "${String(sub)}"`);
      usage();
  }
}
