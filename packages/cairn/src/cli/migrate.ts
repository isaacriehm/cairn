/**
 * `cairn migrate` — bring `.cairn/` state up to the current Cairn version.
 *
 * Runs the coded migration registry: `safe` migrations apply automatically;
 * `review` migrations apply only with `--all` (operator-confirmed). `--dry-run`
 * reports what would run without touching anything. Replaces the scattered
 * `cairn fix <X>` version-keyed repairs.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMigrations, type MigrationOutcome } from "@isaacriehm/cairn-core";

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

function ensureAdopted(repoRoot: string): void {
  if (!existsSync(repoRoot)) {
    console.error(`cairn: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }
  if (!existsSync(`${repoRoot}/.cairn`)) {
    console.error(
      `cairn: ${repoRoot} is not cairn-adopted (no .cairn/). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }
}

function icon(status: MigrationOutcome["status"]): string {
  switch (status) {
    case "applied":
      return "✓";
    case "noop":
      return "○";
    case "queued":
    case "would-queue":
      return "⚠";
    case "failed":
      return "✗";
    case "would-apply":
      return "→";
  }
}

export async function migrateCli(argv: string[]): Promise<void> {
  const repoRoot = parseRepoFlag(argv);
  ensureAdopted(repoRoot);
  const dryRun = argv.includes("--dry-run");
  const includeReview = argv.includes("--all");

  const result = await runMigrations({ repoRoot, dryRun, includeReview });

  if (!result.ran) {
    process.stdout.write(
      "⬡ cairn migrate — another migration is in progress (lock held); skipped.\n",
    );
    process.exit(0);
  }

  process.stdout.write(
    `⬡ cairn migrate — pin ${result.pin} → ${result.current}${dryRun ? " (dry-run)" : ""}\n`,
  );

  if (result.outcomes.length === 0) {
    if (result.newPin !== null) {
      process.stdout.write(`  ✓ Nothing pending — pin bumped to ${result.newPin}.\n`);
    } else {
      process.stdout.write("  ✓ Already up to date.\n");
    }
    process.exit(0);
  }

  for (const o of result.outcomes) {
    process.stdout.write(`  ${icon(o.status)}  ${o.id} — ${o.detail}\n`);
  }
  process.stdout.write("\n");

  const failed = result.outcomes.filter((o) => o.status === "failed").length;
  if (result.newPin !== null) {
    process.stdout.write(`  Pin advanced to ${result.newPin}.\n`);
  }
  if (result.pendingReview.length > 0) {
    process.stdout.write(
      `  ${result.pendingReview.length} review migration(s) need confirmation — re-run with \`cairn migrate --all\`.\n`,
    );
  }
  if (failed > 0) {
    process.stdout.write(`  ${failed} migration(s) failed — state left at last good.\n`);
    process.exit(1);
  }
  process.exit(0);
}
