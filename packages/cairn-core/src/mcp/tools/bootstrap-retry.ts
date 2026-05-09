/**
 * cairn_bootstrap_retry — manual retry for per-clone bootstrap.
 *
 * Spec: PLUGIN_ARCHITECTURE §11 (no CLI subcommand exposure to operator) +
 * §17 Layer 2 (per-clone bootstrap).
 *
 * Surface: when `requireBootstrap` returns `BOOTSTRAP_REQUIRED` because
 * the auto-join path failed (most commonly: hooks dir missing or
 * `git config core.hooksPath` blocked), this tool re-runs the join
 * sequence inline so the operator never sees a CLI subcommand. The
 * `cairn-attention` skill's Step 0 calls this tool when the bootstrap
 * banner is in `additionalContext`; SessionStart's degraded-mode
 * banner cites this tool name as the recovery path.
 *
 * Idempotent. The bootstrap guard is intentionally NOT called here —
 * its sole purpose is to retry bootstrap, so guarding it would be a
 * loop.
 */

import { runJoin } from "../../join/index.js";
import type { McpContext } from "../context.js";
import type { ToolDef } from "./types.js";

const inputShape = {} as const;

interface Input {
  // No inputs — bootstrap retry is keyless and operates on ctx.repoRoot.
}

async function handler(ctx: McpContext, _input: Input): Promise<unknown> {
  const result = runJoin({ repoRoot: ctx.repoRoot });
  const failedSteps = result.steps
    .filter((s) => s.status === "error")
    .map((s) => `${s.step}: ${s.detail}`);
  if (result.bootstrapped) {
    return {
      ok: true,
      bootstrapped: true,
      repo_root: result.repoRoot,
      project_cairn_version: result.projectCairnVersion,
      cli_version: result.cliVersion,
      steps: result.steps,
    };
  }
  return {
    ok: false,
    error: "BOOTSTRAP_FAILED",
    bootstrapped: false,
    repo_root: result.repoRoot,
    project_cairn_version: result.projectCairnVersion,
    cli_version: result.cliVersion,
    steps: result.steps,
    failed_steps: failedSteps,
  };
}

export const bootstrapRetryTool: ToolDef<Input> = {
  name: "cairn_bootstrap_retry",
  description:
    "Retry per-clone bootstrap inline when SessionStart's auto-bootstrap or a write-tool's lazy bootstrap failed. Idempotent. Returns step-by-step status; on success, subsequent MCP write tools no longer return BOOTSTRAP_REQUIRED.",
  inputSchema: inputShape,
  handler,
};
