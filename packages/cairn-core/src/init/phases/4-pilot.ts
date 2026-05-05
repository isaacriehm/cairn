/**
 * Phase 4-pilot — operator picks the seed module.
 *
 * The mapper's `pilot_module` field is the model's first guess; this
 * phase surfaces it alongside the next 2 strongest `key_modules` so
 * the operator can override. Picking the pilot determines which
 * module's globs flow into `.cairn/config.yaml.project_globs` first.
 */

import { advancePhase } from "./orchestrator.js";
import type {
  PhaseOption,
  PhaseQuestion,
  PhaseResult,
  PhaseState,
} from "./types.js";
import type { MapperResult } from "../mapper.js";

const MAX_OPTIONS = 3;

export async function runPhase4Pilot(state: PhaseState): Promise<PhaseResult> {
  const mapper = state.outputs["3-mapper"] as MapperResult | undefined;
  if (mapper === undefined) {
    return {
      status: "error",
      error: {
        code: "missing-prereqs",
        message: "Phase 4 needs phase 3-mapper output",
      },
      state,
    };
  }

  // Operator already picked → consume + advance.
  if (state.answer !== undefined && state.answer.length > 0) {
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "4-pilot": { picked: state.answer } },
      answer: undefined,
    };
    return {
      status: "complete",
      nextPhase: "5-brand",
      state: advancePhase(next),
    };
  }

  const out = mapper.output;
  const candidates: PhaseOption[] = [];
  // Empty path = repo root. Render as `.` so the operator sees a
  // meaningful label instead of an empty string between backticks.
  const pretty = (p: string): string => (p.length === 0 ? "." : p);
  // Pilot first (always at least repo-root, even when empty).
  candidates.push({
    id: out.pilot_module.length > 0 ? out.pilot_module : ".",
    label: pretty(out.pilot_module),
    detail: "Mapper's first pick",
  });
  // Top 2 key_modules other than pilot.
  for (const km of out.key_modules) {
    if (candidates.length >= MAX_OPTIONS) break;
    if (km.path === out.pilot_module) continue;
    candidates.push({
      id: km.path.length > 0 ? km.path : ".",
      label: pretty(km.path),
      detail: km.purpose,
    });
  }
  // Fallback if mapper produced nothing.
  if (candidates.length === 0) {
    candidates.push({ id: ".", label: ".", detail: "Whole repo as the pilot scope" });
  }

  const question: PhaseQuestion = {
    id: "4-pilot",
    prompt: "Which module should Cairn seed first?",
    options: candidates,
    default: candidates[0]!.id,
  };
  return { status: "needs_input", question, state };
}
