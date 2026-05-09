/**
 * Phase 6-brand — adopt brand DEC drafts inline.
 *
 * Emits ONE A/B/C choice. `auto-fill` substitutes positioning +
 * brand-overview + voice + personas from the mapper's domain summary
 * + sensible defaults; `skip` leaves status: draft for later editing;
 * `manual` hands off to the operator (drafts stay draft, summary
 * surfaces the file paths to edit).
 */

import { applyBrandAnswers, type BrandAnswers } from "../brand-setup.js";
import { deriveBrandFromProject, derivedToBrandAnswers } from "../brand-derive.js";
import { advancePhase } from "./orchestrator.js";
import type {
  PhaseQuestion,
  PhaseResult,
  PhaseState,
} from "./types.js";

const DEFAULT_VOICE =
  "Direct, technical, project-aware. Match the existing tone in CLAUDE.md / AGENTS.md if those files set a register; otherwise default to short sentences, full English, no marketing language.";

const DEFAULT_AVOID =
  "Marketing fluff (\"world-class\", \"revolutionary\", \"game-changing\"). Speculative claims about behavior the code does not implement. Anything that contradicts an in-scope DEC or §INV.";

function deriveDefaultUsers(state: PhaseState): string {
  const slug = state.outputs["1-detect"]?.project_slug ?? "this project";
  return `Developers and operators working on ${slug}. Refine when adding consumer-facing or external personas.`;
}

export async function runPhase6Brand(state: PhaseState): Promise<PhaseResult> {
  // Pending operator answer → execute the chosen path.
  if (state.answer !== undefined && state.answer.length > 0) {
    const choice = state.answer;
    let result: { updated: string[]; warnings: string[] } | null = null;
    if (choice === "auto-fill") {
      const mapper = state.outputs["3-mapper"];
      if (mapper !== undefined) {
        const projectSlug = state.outputs["1-detect"]?.project_slug ?? "this-project";
        const derived = await deriveBrandFromProject({
          repoRoot: state.repoRoot,
          projectSlug,
          domainSummary: mapper.output.domain_summary,
        });
        const answers: BrandAnswers = derived !== null
          ? derivedToBrandAnswers(derived)
          : {
              whatItDoes: mapper.output.domain_summary,
              mainUsers: deriveDefaultUsers(state),
              voice: DEFAULT_VOICE,
              avoid: DEFAULT_AVOID,
            };
        result = applyBrandAnswers(state.repoRoot, answers);
        if (derived === null) {
          result.warnings.push(
            "brand-derive: Haiku timeout/parse fail → using mechanical defaults. Re-run `cairn fix brand` after init.",
          );
        }
      }
    }
    const next: PhaseState = {
      ...state,
      outputs: {
        ...state.outputs,
        "6-brand": { choice, applied: result },
      },
      answer: undefined,
    };
    return {
      status: "complete",
      nextPhase: "7-topic-index",
      state: advancePhase(next),
    };
  }

  const question: PhaseQuestion = {
    id: "6-brand",
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
