/**
 * Phase 9f-comp-emit — build the component store at adoption.
 *
 * Deterministic (no LLM), the final leg of the component trio
 * (9d-comp-walk → 9e-comp-annotate → 9f-comp-emit). No-ops on
 * self-adopt or when the project carries no `components:` config, so
 * non-UI repos flow straight through. Otherwise, now that 9e has had a
 * chance to annotate source headers:
 *
 *   1. Build the derived index under `.cairn/ground/components/`.
 *   2. Promote every `@singleton` header to a §INV ledger entry
 *      (verbatim auto-accept, like 9c-emit — the rule is mechanical;
 *      "exists exactly once" is enforced by the check's duplicate-name
 *      gate, not a generic assertion).
 *   3. Run the advisory audit + collect any still-missing-header debt
 *      and write both to a baseline file the cairn-attention skill
 *      triages.
 *
 * Advisory vs gate stays unblurred (port invariant 5): nothing here
 * blocks. The audit + missing headers are surfaced for triage; the
 * daily-flow check is the gate.
 */

import { emitComponentStore } from "../../components/emit.js";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type {
  ComponentsPhaseOutput,
  PhaseResult,
  PhaseState,
} from "./types.js";

const NEXT_PHASE = "10-rules-merge" as const;

function complete(state: PhaseState, out: ComponentsPhaseOutput): PhaseResult {
  const next: PhaseState = {
    ...state,
    outputs: { ...state.outputs, "9f-comp-emit": out },
  };
  return { status: "complete", nextPhase: NEXT_PHASE, state: advancePhase(next) };
}

export async function runPhase9fCompEmit(
  state: PhaseState,
): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    return complete(state, { skipped: "self-adopt" });
  }

  try {
    const r = emitComponentStore(state.repoRoot);
    if (r.skipped) {
      return complete(state, { skipped: "no-components" });
    }
    const out: ComponentsPhaseOutput = {
      indexed: r.indexed,
      missing: r.missing,
      singletons_drafted: r.singletonsDrafted,
      audit_findings: r.auditFindings,
    };
    if (r.baselinePath !== null) out.baseline_path = r.baselinePath;
    return complete(state, out);
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9f-comp-emit-failed",
        message: "Component store build failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
