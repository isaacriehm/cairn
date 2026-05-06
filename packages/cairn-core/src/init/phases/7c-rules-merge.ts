/**
 * Phase 7c-rules-merge — walk CLAUDE.md / AGENTS.md / .claude/rules/*
 * sections, classify via Haiku, propose net-new rules + flag conflicts.
 */

import {
  runRulesMerge,
  type RunRulesMergeResult,
} from "../rules-merge/index.js";
import { clearProgress, writeProgress } from "../progress.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase7cRulesMerge(state: PhaseState): Promise<PhaseResult> {
  const startedAt = Date.now();
  try {
    const result: RunRulesMergeResult = await runRulesMerge({
      repoRoot: state.repoRoot,
      onSectionProgress: (row) =>
        writeProgress(state.repoRoot, {
          phase: "7c-rules-merge",
          batch: row.index,
          total: row.total,
          startedAt,
        }),
    });
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "7c-rules-merge": result },
    };
    return {
      status: "complete",
      nextPhase: "8-baseline",
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
