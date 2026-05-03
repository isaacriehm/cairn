/**
 * Phase 14 — decision capture flow.
 *
 * Public surface:
 *   - runDecisionCapture(args)        → end-to-end (extract → draft → confirm → ledger)
 *   - runDecisionExtractor(input)     → standalone Tier-1 call
 *   - allocateDecisionId(repoRoot)    → next monotonic DEC-id
 *   - writeDecisionDraft, acceptDraft, rejectDraft — mechanical persistence
 *   - DECISION_EXTRACTOR_OUTPUT_SCHEMA, DECISION_EXTRACTOR_SYSTEM_PROMPT — for
 *     consumers that want to call `runClaude` directly
 */

export type {
  CandidateAssertion,
  DecisionCaptureResult,
  DecisionDraft,
  DecisionExtractorInput,
  DecisionExtractorOutput,
  DraftConfirmDecision,
  ConfirmResult,
} from "./types.js";

export { allocateDecisionId } from "./id.js";
export {
  DECISION_EXTRACTOR_SYSTEM_PROMPT,
  buildDecisionExtractorUserPrompt,
} from "./prompt.js";
export { DECISION_EXTRACTOR_OUTPUT_SCHEMA } from "./schema.js";
export { runDecisionExtractor } from "./extractor.js";
export type { ExtractorResult } from "./extractor.js";
export {
  acceptDraft,
  rejectDraft,
  writeDecisionDraft,
} from "./writer.js";
export type {
  AcceptDraftResult,
  WriteDecisionDraftArgs,
} from "./writer.js";
export { runDecisionCapture } from "./capture.js";
export type { RunDecisionCaptureArgs } from "./capture.js";
