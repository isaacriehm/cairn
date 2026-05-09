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
 * first phase becomes "ready".
 *
 * The persisted `state.currentPhase` IS the next phase to run:
 *   - On "complete", the phase function calls `advancePhase` to
 *     increment `currentPhase` to the successor before persisting.
 *   - On "needs_input", `currentPhase` stays put — the operator's
 *     answer feeds back into the same phase.
 *
 * The init-phases MCP tool clears the state file as soon as the final
 * phase returns nextPhase=null, so a "done" report only fires when
 * cleanup itself failed. We model that as "ready" pointing at the last
 * phase id; the skill re-invokes (idempotent) and then clearPhaseState
 * runs again.
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
  return {
    status: "ready",
    nextPhase: persisted.currentPhase,
    state: persisted,
  };
}

/**
 * Self-adoption flag check. True when Phase 1 detect set
 * `outputs["1-detect"].is_self_adopt = true` because the operator is
 * dogfooding Cairn against its own source repo via the
 * `CAIRN_SELF_ADOPT=1` escape hatch. Phases 8 / 9 / 10 / 12 read this
 * and short-circuit so the recursive-ingest scenario (Cairn's own
 * docs / source comments / CLAUDE.md / essay-class block strip)
 * never runs against the source tree.
 */
export function isSelfAdoptState(state: PhaseState): boolean {
  return state.outputs["1-detect"]?.is_self_adopt === true;
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
