/**
 * Phase 1-detect — synchronous environment + stack signature scan.
 *
 * Wraps `detectAll` in the PhaseResult contract. Output stamped under
 * `state.outputs["1-detect"]` is the full DetectionResult so downstream
 * phases can read repo_root, stack, sensors, etc. without re-detecting.
 *
 * Self-adoption guard fires here: if `repoRoot` is the Cairn source
 * repo itself, refuse with `cairn-source-repo` so adoption can't
 * overwrite Cairn's own internals. Override with the
 * `CAIRN_SELF_ADOPT=1` env var when actually dogfooding (gated; not
 * for normal use).
 *
 * Side-effects on success:
 *   - WSL+Linux → run `applyPostInitGitConfig` so safe.directory +
 *     core.fileMode false get applied even when the operator (not
 *     Cairn) drove the original `git init`.
 *   - Always → `ensureSkillBudgetFloor` raises the user-level
 *     `skillListingBudgetFraction` to the cairn floor so Sonnet/Haiku
 *     keep listing `cairn-direction` in full. Idempotent + silent.
 */

import { detectAll } from "../detect.js";
import { applyPostInitGitConfig, detectWsl } from "../post-git-init.js";
import { isCairnSourceRepo } from "../preflight-guards.js";
import { ensureSkillBudgetFloor } from "../skill-budget.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase1Detect(state: PhaseState): Promise<PhaseResult> {
  if (
    isCairnSourceRepo(state.repoRoot) &&
    process.env["CAIRN_SELF_ADOPT"] !== "1"
  ) {
    return {
      status: "error",
      error: {
        code: "cairn-source-repo",
        message:
          "This looks like the Cairn source repository — adoption refused to avoid overwriting cairn internals.",
        detail:
          "If you are actually dogfooding Cairn against itself, set CAIRN_SELF_ADOPT=1 in the environment and re-invoke. Otherwise, run cairn-adopt against a project that USES Cairn, not Cairn itself.",
      },
      state,
    };
  }
  try {
    const detection = await detectAll({ repoRoot: state.repoRoot });
    if (detectWsl()) {
      applyPostInitGitConfig({ repoRoot: state.repoRoot });
    }
    try {
      ensureSkillBudgetFloor();
    } catch {
      // Best-effort — adoption never aborts because user-level
      // config couldn't be patched.
    }
    // Self-adopt flag: only true when the upstream guard let us
    // through (Cairn source repo + CAIRN_SELF_ADOPT=1). Phases
    // 8/9/10/12 read this and short-circuit so the recursive-ingest
    // scenario (Cairn's own docs / CLAUDE.md / essay comments) never
    // runs against the source tree.
    detection.is_self_adopt = isCairnSourceRepo(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "1-detect": detection },
    };
    return {
      status: "complete",
      nextPhase: "2-walker",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "detect-failed",
        message: "Failed to scan project environment",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
