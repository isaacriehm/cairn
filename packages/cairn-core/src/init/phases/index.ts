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
  MAPPER_OUTPUT_PATH,
  mapperOutputAbsPath,
  readMapperOutputFile,
  writeMapperOutputFile,
  toMapperResultPersisted,
  type MapperResultPersisted,
} from "./mapper-output-io.js";

export {
  freshPhaseState,
  resumePhases,
  nextPhaseAfter,
  advancePhase,
} from "./orchestrator.js";

export { runPhase1Detect } from "./1-detect.js";
export { runPhase2Walker } from "./2-walker.js";
export { runPhase3Mapper } from "./3-mapper.js";
export { runPhase4Seed } from "./4-seed.js";
export { runPhase5Preflight } from "./5-preflight.js";
export type { PreflightOutput, PreflightUnits, PreflightEta } from "./5-preflight.js";
export { runPhase6Brand } from "./6-brand.js";
export { runPhase7TopicIndex } from "./7-topic-index.js";
export type { TopicIndexPhaseOutput } from "./7-topic-index.js";
export { runPhase8DocsIngest } from "./8-docs-ingest.js";
export { runPhase9SourceComments } from "./9-source-comments.js";
export { runPhase10RulesMerge } from "./10-rules-merge.js";
export { runPhase11Baseline } from "./11-baseline.js";
export { runPhase12Strip } from "./12-strip.js";
export { runPhase13Multidev } from "./13-multidev.js";
export { runPhases8910Parallel } from "./parallel-8910.js";

export {
  SOURCE_COMMENTS_WALK_PATH,
  sourceCommentsWalkAbsPath,
  readSourceCommentsWalkFile,
  writeSourceCommentsWalkFile,
  to7bResultPersisted,
  type IngestSourceCommentsResultPersisted,
} from "./source-comments-output-io.js";
