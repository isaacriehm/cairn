/**
 * Bootstrap guard for MCP write tools.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 4 (degraded mode).
 *
 * Each MCP write tool calls `requireBootstrap(repoRoot)` at the top of its
 * executor. When the clone is unbootstrapped, the helper returns a
 * `BOOTSTRAP_REQUIRED` envelope and the tool short-circuits — no lock, no
 * filesystem write. Read tools (decision-get, search, etc.) skip this guard
 * entirely, matching spec §17 "MCP read tools work (read-only)".
 *
 * Bootstrap state is cheap to inspect (one `git config --get`); we don't
 * cache because a session that ran `harness join` mid-conversation should
 * be able to write on its next call.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectJoinState } from "../join/index.js";
import { mcpError, type McpErrorPayload } from "./errors.js";

/**
 * The guard only blocks when *all three* are true:
 *   1. `<repoRoot>/.git/` exists (otherwise this isn't a real clone)
 *   2. `<repoRoot>/.harness/config.yaml` exists (otherwise the project
 *      isn't actually harness-adopted yet — `harness init` will land it)
 *   3. `git config core.hooksPath` is *not* `.harness/git-hooks`
 *
 * Everything else passes through. This keeps unit / smoke fixtures that
 * scaffold a partial `.harness/` from being incorrectly degraded; the only
 * scenario that trips the guard is a real adopted project on a clone where
 * `harness join` hasn't run yet.
 */
export function requireBootstrap(repoRoot: string): McpErrorPayload | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  if (!existsSync(join(repoRoot, ".harness", "config.yaml"))) return null;
  const state = inspectJoinState({ repoRoot });
  if (state.hooksPathSet) return null;
  return mcpError(
    "BOOTSTRAP_REQUIRED",
    "this clone is not bootstrapped — run `harness join` (or pick [a] on the inline SessionStart prompt) before harness write tools engage",
    {
      project_harness_version: state.projectHarnessVersion,
      hooks_path_value: state.hooksPathValue,
      sessions_dir_ready: state.sessionsDirReady,
      remediation: "harness join",
    },
  );
}
