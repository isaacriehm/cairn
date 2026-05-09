/**
 * Phase 12-strip — per-module strip-replace consent.
 *
 * Surfaces each ingestion-flagged module as an A/B/C choice (strip /
 * keep / skip). Tracks remaining modules in
 * `outputs["12-strip"].pending` and emits one question at a time
 * until the queue is empty.
 */

import { advancePhase } from "./orchestrator.js";
import type {
  PhaseQuestion,
  PhaseResult,
  PhaseState,
} from "./types.js";

interface StripState {
  /** Modules still awaiting an a/b/c decision. */
  pending: string[];
  /** Modules + their final decision keyed by path. */
  decisions: Record<string, "strip" | "keep" | "skip">;
}

export async function runPhase12Strip(state: PhaseState): Promise<PhaseResult> {
  const existing = state.outputs["12-strip"] as StripState | undefined;
  const modules: string[] = computeFlaggedModules(state);

  // Initialize on first entry.
  let s: StripState = existing ?? { pending: [...modules], decisions: {} };

  // Operator just answered → record + dequeue.
  if (state.answer !== undefined && state.answer.length > 0 && s.pending.length > 0) {
    const head = s.pending[0]!;
    const choice = normalizeChoice(state.answer);
    s = {
      pending: s.pending.slice(1),
      decisions: { ...s.decisions, [head]: choice },
    };
  }

  if (s.pending.length === 0) {
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "12-strip": s },
      answer: undefined,
    };
    return {
      status: "complete",
      nextPhase: "13-multidev",
      state: advancePhase(next),
    };
  }

  const head = s.pending[0]!;
  const question: PhaseQuestion = {
    id: `12-strip:${head}`,
    prompt: `Strip the source-comment essay in ${head}?`,
    options: [
      {
        id: "strip",
        label: "strip — DEC is the source of truth",
      },
      {
        id: "keep",
        label: "keep — leave comment alongside DEC",
      },
      {
        id: "skip",
        label: "skip — decide later",
      },
    ],
    default: "skip",
  };
  return {
    status: "needs_input",
    question,
    state: { ...state, outputs: { ...state.outputs, "12-strip": s }, answer: undefined },
  };
}

function normalizeChoice(answer: string): "strip" | "keep" | "skip" {
  switch (answer) {
    case "strip":
    case "keep":
    case "skip":
      return answer;
    default:
      return "skip";
  }
}

function computeFlaggedModules(_state: PhaseState): string[] {
  return [];
}
