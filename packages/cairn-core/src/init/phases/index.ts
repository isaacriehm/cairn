export {
  PHASE_IDS,
  type PhaseId,
  type PhaseState,
  type PhaseOutputs,
  type PhaseResult,
  type PhaseQuestion,
  type PhaseOption,
  type PhaseError,
  type ResumeReport,
} from "./types.js";

export {
  INIT_STATE_PATH,
  phaseStateAbsPath,
  readPhaseState,
  writePhaseState,
  clearPhaseState,
} from "./state-io.js";

export {
  freshPhaseState,
  resumePhases,
  nextPhaseAfter,
  advancePhase,
} from "./orchestrator.js";

export { runPhase1Detect } from "./1-detect.js";
export { runPhase2Walker } from "./2-walker.js";
export { runPhase3Mapper } from "./3-mapper.js";
export { runPhase3bSeed } from "./3b-seed.js";
export { runPhase4Pilot } from "./4-pilot.js";
export { runPhase5Brand } from "./5-brand.js";
export { runPhase6DocsIngest } from "./6-docs-ingest.js";
export { runPhase7bSourceComments } from "./7b-source-comments.js";
export { runPhase7cRulesMerge } from "./7c-rules-merge.js";
export { runPhase8Baseline } from "./8-baseline.js";
export { runPhase10Strip } from "./10-strip.js";
export { runPhase12Multidev } from "./12-multidev.js";
