/**
 * Phase 5-brand — adopt brand DEC drafts inline.
 *
 * v0.1.x's 4-question wizard required a TTY and was skipped under
 * --no-prompt, leaving brand status at "draft" forever. v0.2.0 cuts
 * the synchronous wizard: the seeded brand DEC drafts stay drafts
 * until the operator either edits them directly or accepts the
 * mapper-derived auto-fill.
 *
 * This phase emits ONE A/B/C choice. b/auto-fill substitutes
 * positioning + voice from the mapper's domain summary; a/skip
 * leaves status: draft for later editing; c/manual hands off to
 * the operator (drafts stay draft, summary surfaces the file paths
 * to edit).
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
    prompt: "Brand DEC drafts — how should Cairn populate them?",
    options: [
      {
        id: "skip",
        label: "skip — keep drafts blank, edit later",
        detail: ".cairn/ground/brand/* stays status: draft",
      },
      {
        id: "auto-fill",
        label: "auto-fill from mapper's domain summary",
        detail: "positioning.md gets the mapper's summary, status flips to current",
      },
      {
        id: "manual",
        label: "manual — I'll edit the drafts before accepting",
        detail: "Drafts stay status: draft; cairn-attention surfaces them later",
      },
    ],
    default: "skip",
  };
  return { status: "needs_input", question, state };
}
