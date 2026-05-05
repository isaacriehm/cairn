/**
 * Orchestrator entry points for the MCP-native init pipeline.
 *
 * `resumePhases(repoRoot)` is the single readable surface for the
 * cairn-adopt skill — it reads any persisted state, returns the next
 * phase id, and (for fresh starts) constructs the initial PhaseState.
 *
 * Phase functions live in sibling files (one per id, see types.ts
 * PHASE_IDS). The orchestrator does not invoke them directly; the
 * skill driver calls each phase's MCP tool with the state returned
 * from `resumePhases` and threads results forward.
 */

import { PHASE_IDS, type PhaseId, type PhaseState, type ResumeReport } from "./types.js";
import { readPhaseState } from "./state-io.js";

/**
 * Construct the fresh state for a brand-new init run. No filesystem
 * IO — the caller persists this via `writePhaseState` once phase
 * 1-detect has created `.cairn/`.
 */
export function freshPhaseState(repoRoot: string): PhaseState {
  return {
    repoRoot,
    currentPhase: PHASE_IDS[0],
    outputs: {},
    startedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

/**
 * Read whatever init state is on disk for `repoRoot` and return the
 * next phase the skill driver should invoke. If no state exists, the
 * first phase becomes "ready"; if `currentPhase` is the last id, the
 * pipeline reports "done".
 */
export function resumePhases(repoRoot: string): ResumeReport {
  const persisted = readPhaseState(repoRoot);
  if (persisted === null) {
    return {
      status: "ready",
      nextPhase: PHASE_IDS[0],
      state: freshPhaseState(repoRoot),
    };
  }
  const next = nextPhaseAfter(persisted.currentPhase);
  return {
    status: next === null ? "done" : "ready",
    nextPhase: next,
    state: persisted,
  };
}

/**
 * Compute the phase id that follows `current` in PHASE_IDS, or null
 * when `current` is already the last id. Pure function — useful from
 * inside individual phase functions when stamping their PhaseResult.
 */
export function nextPhaseAfter(current: PhaseId): PhaseId | null {
  const idx = PHASE_IDS.indexOf(current);
  if (idx === -1) return null;
  if (idx === PHASE_IDS.length - 1) return null;
  return PHASE_IDS[idx + 1] ?? null;
}

/**
 * Advance `state.currentPhase` to the next phase id. Returns a new
 * state; does not mutate the input. Used by phase functions when
 * stamping a "complete" result that hands off to the next phase.
 */
export function advancePhase(state: PhaseState): PhaseState {
  const next = nextPhaseAfter(state.currentPhase);
  if (next === null) return state;
  return { ...state, currentPhase: next, answer: undefined };
}
