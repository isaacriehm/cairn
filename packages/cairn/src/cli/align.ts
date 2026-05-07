/**
 * `cairn align <subcommand>` — Layer C/D operator surface.
 *
 *   cairn align drain   Layer C SessionStart drain (plan §4.3) —
 *                       reads the deferred logs written by Layer A +
 *                       Layer B, re-checks each block, runs the Haiku
 *                       dedup judge for ambiguous candidates, and
 *                       applies cite / drop / alignment-pending. Capped
 *                       at 30 Haiku calls by default.
 *
 * Future subcommands (block 9 — Layer D):
 *   cairn fix align     full-repo Haiku-judge sweep (`fix` namespace).
 *   cairn align undo    rollback recent auto-resolutions.
 */

import { resolveRepoRoot, runDrain } from "@isaacriehm/cairn-core";
import { resolve } from "node:path";

interface DrainFlags {
  repoRoot: string;
  sessionId: string | null;
  maxHaikuCalls: number | null;
  dryRun: boolean;
}

function usage(): never {
  console.error(
    "Usage: cairn align <subcommand>\n" +
      "  drain                              Layer C SessionStart drain.\n" +
      "    [--session-id <id>]              push drain blips to this session\n" +
      "    [--max-haiku-calls <n>]          cap Haiku judge calls (default 30)\n" +
      "    [--dry-run]                      classify only; no source / log writes\n" +
      "    [--repo <path>]                  override the cairn repo root\n",
  );
  process.exit(1);
}

function parseDrainFlags(argv: string[]): DrainFlags {
  let sessionId: string | null = null;
  let maxHaikuCalls: number | null = null;
  let dryRun = false;
  let repoOverride: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-id") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--session-id requires a value");
        process.exit(2);
      }
      sessionId = v;
      i += 1;
    } else if (a === "--max-haiku-calls") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--max-haiku-calls requires a value");
        process.exit(2);
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`--max-haiku-calls invalid: ${v}`);
        process.exit(2);
      }
      maxHaikuCalls = n;
      i += 1;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--repo") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--repo requires a path");
        process.exit(2);
      }
      repoOverride = resolve(v);
      i += 1;
    } else {
      console.error(`cairn align drain: unknown flag "${a}"`);
      usage();
    }
  }

  const repoRoot = repoOverride ?? resolveRepoRoot(process.cwd());
  if (repoRoot === null) {
    console.error("cairn align drain: not inside a cairn-adopted repo");
    process.exit(2);
  }
  return { repoRoot, sessionId, maxHaikuCalls, dryRun };
}

export async function alignCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case undefined:
    case "drain": {
      const flags = parseDrainFlags(argv.slice(1));
      const args: Parameters<typeof runDrain>[0] = {
        repoRoot: flags.repoRoot,
        sessionId: flags.sessionId,
      };
      if (flags.maxHaikuCalls !== null) args.maxHaikuCalls = flags.maxHaikuCalls;
      if (flags.dryRun) args.dryRun = true;
      const result = await runDrain(args);
      const summary = [
        `cairn align drain — ${flags.dryRun ? "DRY-RUN " : ""}done`,
        `  total entries:        ${result.totalEntries}`,
        `  cited (deterministic) ${result.citedDeterministic}`,
        `  cited (Haiku)         ${result.citedHaiku}`,
        `  dropped (different)   ${result.droppedDifferent}`,
        `  dropped (missing)     ${result.droppedMissing}`,
        `  alignment-pending     ${result.pending}`,
        `  deferred (cap/offline) ${result.deferred}`,
        `  Haiku calls           ${result.haikuCalls}`,
        `  Haiku fallback        ${result.haikuFallback ? "yes (offline)" : "no"}`,
      ].join("\n");
      process.stdout.write(`${summary}\n`);
      return;
    }
    default:
      console.error(`cairn align: unknown subcommand "${sub}"`);
      usage();
  }
}
