/**
 * Phase 5-pilot — operator picks the seed module.
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

const MAX_OPTIONS = 3;

export async function runPhase5Pilot(state: PhaseState): Promise<PhaseResult> {
  const mapper = state.outputs["3-mapper"];
  if (mapper === undefined) {
    return {
      status: "error",
      error: {
        code: "missing-prereqs",
        message: "Phase 5 needs phase 3-mapper output",
      },
      state,
    };
  }

  // Operator already picked → consume + advance.
  if (state.answer !== undefined && state.answer.length > 0) {
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "5-pilot": { picked: state.answer } },
      answer: undefined,
    };
    return {
      status: "complete",
      nextPhase: "6-brand",
      state: advancePhase(next),
    };
  }

  const out = mapper.output;
  const candidates: PhaseOption[] = [];
  // Canonicalize repo-root forms — mapper can emit "" (key_module),
  // "." (Haiku merge override), or "ALL" (mapper-merge fallback) for
  // the same logical "whole repo" pick. Collapse them so dedup works.
  const canonId = (p: string): string => {
    const trimmed = p.trim();
    if (trimmed.length === 0 || trimmed === "ALL") return ".";
    return trimmed;
  };
  // Render the repo-root canonical id with a contextual label so the
  // operator doesn't see a bare dot or the literal "ALL" between
  // backticks.
  const labelFor = (p: string): string => (canonId(p) === "." ? "Repo root (.)" : p);
  const seen = new Set<string>();
  const pushUnique = (opt: PhaseOption): void => {
    if (seen.has(opt.id)) return;
    seen.add(opt.id);
    candidates.push(opt);
  };
  // Pilot first (always at least repo-root, even when empty).
  pushUnique({
    id: canonId(out.pilot_module),
    label: labelFor(out.pilot_module),
    detail: "Mapper's first pick",
  });
  // Top 2 key_modules other than pilot — dedup by canonical id so a
  // key_module pointing at the same path as the pilot doesn't surface
  // as a phantom second option.
  for (const km of out.key_modules) {
    if (candidates.length >= MAX_OPTIONS) break;
    pushUnique({
      id: canonId(km.path),
      label: labelFor(km.path),
      detail: km.purpose,
    });
  }
  // Fallback if mapper produced nothing.
  if (candidates.length === 0) {
    pushUnique({
      id: ".",
      label: "Repo root (.)",
      detail: "Whole repo as the pilot scope",
    });
  }

  // Single candidate → no real choice for the operator. Auto-pick and
  // skip the prompt rather than burning an interaction on a one-option
  // AskUserQuestion.
  if (candidates.length === 1) {
    const picked = candidates[0]!.id;
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "5-pilot": { picked } },
      answer: undefined,
    };
    return {
      status: "complete",
      nextPhase: "6-brand",
      state: advancePhase(next),
    };
  }

  const question: PhaseQuestion = {
    id: "5-pilot",
    prompt: "Which module should Cairn seed first?",
    options: candidates,
    default: candidates[0]!.id,
  };
  return { status: "needs_input", question, state };
}
