#!/usr/bin/env node
/**
 * Bin entrypoint — `node cairn-core/dist/mcp/serve.js`.
 *
 * Plugin manifest (`.mcp.json`) registers this path so the cairn MCP
 * server starts without depending on the `cairn` umbrella CLI being
 * on PATH. The umbrella's `cairn mcp serve` calls `startMcpServer`
 * directly via the library export.
 *
 * Flags:
 *   --repo-root <path>     adopted-project repo root (required; defaults to cwd)
 *   --session-id <id>      Claude Code session id (stamped onto invalidation events)
 *   --run-id <id>          scope telemetry to a run id
 */

import { resolve } from "node:path";
import { createContext } from "./context.js";
import { startMcpServer } from "./server.js";
import { logger } from "../logger.js";
import { resolveAnchorRoot } from "../session-start/index.js";

const log = logger("mcp.serve");

interface ParsedArgs {
  repoRoot: string;
  sessionId: string | null;
  runId: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let repoRoot: string | null = null;
  let sessionId: string | null = null;
  let runId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo-root" && i + 1 < argv.length) {
      repoRoot = resolve(argv[i + 1]!);
      i += 1;
    } else if (arg === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[i + 1]!;
      i += 1;
    } else if (arg === "--run-id" && i + 1 < argv.length) {
      runId = argv[i + 1]!;
      i += 1;
    }
  }
  // When `--repo-root` is omitted, infer the anchor root. Critical for
  // subdir / worktree-cwd launches: `resolveAnchorRoot` collapses to the
  // adopted `.cairn/` (or, failing that, the git repo root) so MCP writes
  // and hook reads agree on a single state directory — never the launch
  // subdir. `resolve` is retained as the in-tree-less last resort inside
  // `resolveAnchorRoot`.
  const fallback = resolveAnchorRoot(process.cwd());
  return {
    repoRoot: repoRoot ?? fallback,
    sessionId,
    runId,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = createContext({
    repoRoot: args.repoRoot,
    ...(args.runId !== null ? { runId: args.runId } : {}),
    ...(args.sessionId !== null ? { sessionId: args.sessionId } : {}),
  });
  const { close } = await startMcpServer({ ctx });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info({ signal }, "shutdown signal received");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => {
    /* event loop kept alive by the stdio transport */
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[cairn mcp] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
