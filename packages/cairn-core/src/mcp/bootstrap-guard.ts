/**
 * Bootstrap guard for MCP write tools.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 4 (degraded mode).
 *
 * Each MCP write tool calls `requireBootstrap(repoRoot)` at the top of
 * its executor. The guard auto-runs `cairn join` when the clone isn't
 * yet bootstrapped — covers the multi-dev case where a teammate
 * installs the plugin mid-session (via `/plugin install`) and the
 * SessionStart hook never fired for this session, leaving
 * `core.hooksPath` unset. Without lazy bootstrap, the first MCP write
 * call would refuse with `BOOTSTRAP_REQUIRED` even though every
 * prerequisite for a successful join is in place.
 *
 * Auto-join is idempotent and local-clone-only (git config + chmod +
 * gitignored sentinel files). Plugin install is implicit consent for
 * this local config wiring; no operator prompt needed. If the join
 * itself fails, the guard surfaces a `BOOTSTRAP_REQUIRED` envelope with
 * the per-step error detail so the operator knows exactly what failed.
 *
 * Read tools (decision-get, search, etc.) skip this guard entirely,
 * matching spec §17 "MCP read tools work (read-only)".
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectJoinState, runJoin } from "../join/index.js";
import { logger } from "../logger.js";
import { mcpError, type McpErrorPayload } from "./errors.js";
import { cairnDir } from "@isaacriehm/cairn-state";

const log = logger("mcp.bootstrap-guard");

/**
 * The guard only blocks when *all three* are true:
 *   1. `<repoRoot>/.git/` exists (otherwise this isn't a real clone)
 *   2. `<repoRoot>/.cairn/config.yaml` exists (otherwise the project
 *      isn't actually cairn-adopted yet — `cairn init` will land it)
 *   3. `git config core.hooksPath` is *not* `.cairn/git-hooks`
 *
 * Everything else passes through. This keeps unit / smoke fixtures that
 * scaffold a partial `.cairn/` from being incorrectly degraded; the only
 * scenario that trips the guard is a real adopted project on a clone where
 * `cairn join` hasn't run yet.
 *
 * On the third condition, the guard now attempts auto-join before
 * returning the `BOOTSTRAP_REQUIRED` envelope — see module docstring.
 */
export function requireBootstrap(repoRoot: string): McpErrorPayload | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  if (!existsSync(cairnDir(repoRoot, "config.yaml"))) return null;
  const state = inspectJoinState({ repoRoot });
  if (state.hooksPathSet) return null;

  // A foreign `core.hooksPath` (husky / lefthook / custom) is a terminal
  // state — Cairn refuses to clobber it (§3.3 seam 5), so re-running join can
  // never wire the hooks. Don't block MCP writes (decision capture, etc.) or
  // thrash a full join on every write; Cairn runs in advisory mode, only the
  // local git-hook sensor sweep is inactive. The SessionStart banner surfaces
  // the conflict + remediation.
  if (state.hooksPathConflict) return null;

  // Lazy bootstrap: SessionStart's auto-join didn't run for this session
  // (most commonly: teammate installed the plugin mid-session via
  // `/plugin install`, so the plugin SessionStart hook never fired).
  // Run `cairn join` synchronously now. Idempotent + local-clone-only
  // state — plugin install is implicit consent.
  const joinResult = runJoin({ repoRoot });
  if (joinResult.bootstrapped) {
    log.info(
      { repoRoot, source: "lazy-mcp-bootstrap" },
      "auto-ran cairn join from MCP write-tool guard",
    );
    return null;
  }
  // Join itself failed — surface the per-step detail so the operator
  // knows what to fix. Better signal than a flat "run cairn join" hint
  // because the easy path was already attempted.
  const failedSteps = joinResult.steps
    .filter((s) => s.status === "error")
    .map((s) => `${s.step}: ${s.detail}`);
  return mcpError(
    "BOOTSTRAP_REQUIRED",
    "this clone is not bootstrapped and the auto-bootstrap retry failed — see failed_steps for the underlying cause",
    {
      project_cairn_version: state.projectCairnVersion,
      hooks_path_value: state.hooksPathValue,
      sessions_dir_ready: state.sessionsDirReady,
      failed_steps: failedSteps,
      remediation:
        "Invoke the `cairn_bootstrap_retry` MCP tool to retry inline, or restart Claude Code so SessionStart's bootstrap path retries.",
    },
  );
}
