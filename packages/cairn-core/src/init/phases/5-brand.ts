/**
 * Phase 5-brand — adopt brand DEC drafts inline.
 *
 * Emits ONE A/B/C choice. `auto-fill` substitutes positioning + voice
 * from the mapper's domain summary; `skip` leaves status: draft for
 * later editing; `manual` hands off to the operator (drafts stay
 * draft, summary surfaces the file paths to edit).
 */

import { applyBrandAnswers, type BrandAnswers } from "../brand-setup.js";
import { advancePhase } from "./orchestrator.js";
import type {
  PhaseQuestion,
  PhaseResult,
  PhaseState,
} from "./types.js";
import type { MapperResult } from "../mapper.js";

export async function runPhase5Brand(state: PhaseState): Promise<PhaseResult> {
  // Pending operator answer → execute the chosen path.
  if (state.answer !== undefined && state.answer.length > 0) {
    const choice = state.answer;
    let result: { updated: string[]; warnings: string[] } | null = null;
    if (choice === "auto-fill") {
      const mapper = state.outputs["3-mapper"] as MapperResult | undefined;
      if (mapper !== undefined) {
        const answers: BrandAnswers = {
          whatItDoes: mapper.output.domain_summary,
          mainUsers: "",
          voice: "",
          avoid: "",
        };
        result = applyBrandAnswers(state.repoRoot, answers);
      }
    }
    const next: PhaseState = {
      ...state,
      outputs: {
        ...state.outputs,
        "5-brand": { choice, applied: result },
      },
      answer: undefined,
    };
    return {
      status: "complete",
      nextPhase: "6-docs-ingest",
      state: advancePhase(next),
    };
  }

  const question: PhaseQuestion = {
    id: "5-brand",
    prompt: "Auto-fill brand text (positioning + voice)?",
    options: [
      {
        id: "auto-fill",
        label: "yes, auto-fill",
        detail: "Use the mapper's domain summary; mark brand files current",
      },
      {
        id: "skip",
        label: "skip for now",
        detail: "Brand files stay as drafts; populate later when ready",
      },
      {
        id: "manual",
        label: "I'll edit the drafts myself",
        detail: "Open .cairn/ground/brand/* after adoption to fill in",
      },
    ],
    default: "auto-fill",
  };
  return { status: "needs_input", question, state };
}
