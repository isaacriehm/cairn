/**
 * Phase 9c-emit — deterministic curator emit (v0.9.0).
 *
 * Reads `.cairn/init/curator/final.jsonl`, validates each entry via
 * the strict validators in `curator/validate.ts`, and writes
 * surviving entries directly to `.cairn/ground/decisions/<id>.md`
 * (DEC) or `.cairn/ground/invariants/<id>.md` (INV) with
 * `status: accepted` / `status: active`. Invalid entries drop
 * silently with a counter — operator's "auto-accept" directive in
 * the curator plan means the bar is hard, not deferred to inbox.
 */

import { isSelfAdoptState, advancePhase } from "./orchestrator.js";
import type { EmitOutput, PhaseResult, PhaseState } from "./types.js";

export async function runPhase9cEmit(state: PhaseState): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    const skipped: EmitOutput = { skipped: "self-adopt" };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9c-emit": skipped },
    };
    return {
      status: "complete",
      nextPhase: "9d-comp-walk",
      state: advancePhase(next),
    };
  }
  try {
    const { runCuratorEmit } = await import("../curator/emit.js");
    const result = await runCuratorEmit({ repoRoot: state.repoRoot });
    const out: EmitOutput = {
      decsWritten: result.decsWritten,
      invsWritten: result.invsWritten,
      dropped: result.dropped,
      dropReasons: result.dropReasons,
    };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9c-emit": out },
    };
    return {
      status: "complete",
      nextPhase: "9d-comp-walk",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9c-emit-failed",
        message: "Curator emit failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
