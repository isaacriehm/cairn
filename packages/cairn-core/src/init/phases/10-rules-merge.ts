/**
 * Phase 10-rules-merge — walk CLAUDE.md / AGENTS.md / .claude/rules/*
 * sections, classify via Haiku, propose net-new rules + flag conflicts.
 */

import {
  runRulesMerge,
  type RunRulesMergeResult,
} from "../rules-merge/index.js";
import { clearProgress, writeProgress } from "../progress.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase10RulesMerge(state: PhaseState): Promise<PhaseResult> {
  const startedAt = Date.now();
  try {
    const result: RunRulesMergeResult = await runRulesMerge({
      repoRoot: state.repoRoot,
    });
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "10-rules-merge": result },
    };
    return {
      status: "complete",
      nextPhase: "11-baseline",
      state: advancePhase(next),
    };
  } catch (err) {
    clearProgress(state.repoRoot);
    return {
      status: "error",
      error: {
        code: "rules-merge-failed",
        message: "Rules merge failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
