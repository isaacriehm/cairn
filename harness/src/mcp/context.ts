import { resolve } from "node:path";

/**
 * Per-server context. Set at server start; passed to every tool handler.
 *
 * The MCP server is started with `--repo-root <path>` (or HARNESS_REPO_ROOT
 * env). All tool handlers operate against this root. The orchestrator pins a
 * mirror checkout SHA and starts a server with that mirror's path as repoRoot.
 */
export interface McpContext {
  repoRoot: string;
  /** Optional run id — when set, telemetry writes per-run; otherwise, top-level. */
  runId?: string;
}

export function createContext(opts: { repoRoot: string; runId?: string }): McpContext {
  return {
    repoRoot: resolve(opts.repoRoot),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  };
}
