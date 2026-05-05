export {
  detectAll,
  detectAvailableSensors,
  detectEnvironment,
  detectHookCapability,
  detectOriginUrl,
  detectProjectSlug,
  detectStackSignatures,
  detectStartCommand,
} from "./detect.js";
export {
  installInitCancelHandlers,
  startProgress,
  startSpinner,
  withSpinner,
} from "./visual.js";
export { applyBrandAnswers, runBrandSetup } from "./brand-setup.js";
export type {
  BrandAnswers,
  RunBrandSetupOptions,
} from "./brand-setup.js";
export {
  defaultBaselineLanguages,
  findLatestBaselineAudit,
  runBaselineAudit,
} from "./baseline-audit.js";
export type {
  BaselineAuditFinding,
  BaselineAuditResult,
  BaselineAuditSensorRow,
  RunBaselineAuditArgs,
} from "./baseline-audit.js";
export {
  discoverDocs,
  runDocsIngestion,
} from "./ingest-docs.js";
export {
  HEURISTIC as SOURCE_COMMENT_HEURISTIC,
  applyStripReplace,
  classifyBlocks,
  detectLang as detectSourceCommentLang,
  previewStripReplace,
  runSourceCommentsIngestion,
  walkSourceComments,
} from "./source-comments/index.js";
export {
  KEEP_END_MARKER,
  KEEP_START_MARKER,
  discoverRuleSources,
  extractKeepBlocks,
  parseRuleSections,
  reapplyKeepBlocks,
  regenerateRulesFiles,
  renderKeepBlock,
  runRulesMerge,
} from "./rules-merge/index.js";
export {
  installMultiDev,
  patchPackageJsonPrepare,
} from "./multi-dev/index.js";
export type {
  InstallMultiDevArgs,
  MultiDevHostKind,
  MultiDevInstallResult,
  MultiDevInstallStep,
} from "./multi-dev/index.js";
export type {
  KeepBlock,
  RegenerateRulesArgs,
  RegenerateRulesResult,
  RuleClassKind,
  RuleClassification,
  RuleSection,
  RuleSourceFile,
  RunRulesMergeArgs,
  RunRulesMergeResult,
} from "./rules-merge/index.js";
export type {
  ClassifyArgs as SourceCommentClassifyArgs,
  ClassifyResult as SourceCommentClassifyResult,
  CommentBlock,
  CommentClassKind,
  CommentClassification,
  CommentKind,
  CommentLang,
  DirtyDecision,
  FileOutcome as StripReplaceFileOutcome,
  IngestSourceCommentsArgs,
  IngestSourceCommentsResult,
  ReplaceItem,
  SkipReason as StripReplaceSkipReason,
  StripReplaceArgs,
  StripReplaceResult,
  WalkOptions as SourceCommentWalkOptions,
  WalkResult as SourceCommentWalkResult,
} from "./source-comments/index.js";
export type {
  ClassifiedDoc,
  DocCandidate,
  DocClassification,
  DocClassificationKind,
  IngestionResult,
  RunDocsIngestionArgs,
} from "./ingest-docs.js";
export { runInit } from "./init.js";
export type { InitResult, RunInitArgs } from "./init.js";
export {
  buildMapperUserPrompt,
  MAPPER_OUTPUT_SCHEMA,
  MAPPER_SYSTEM_PROMPT,
  runMapper,
  validateMapperOutput,
} from "./mapper.js";
export type {
  MapperKeyModule,
  MapperOutput,
  MapperProposedSensor,
  MapperResult,
  MapperScopeIndex,
  MapperScopeIndexEntry,
  RunMapperArgs,
} from "./mapper.js";
export { sliceModules } from "./module-slicer.js";
export type { ModuleSlice, SliceModulesArgs } from "./module-slicer.js";
export { mapModulesParallel } from "./mapper-parallel.js";
export type {
  MapModulesParallelArgs,
  ModuleProposal,
} from "./mapper-parallel.js";
export { mergeModuleProposals, mechanicalMerge } from "./mapper-merge.js";
export type { MergeArgs } from "./mapper-merge.js";
export { seedCairnLayout, templatesRoot } from "./seed.js";
export type { SeedOptions, SeedResult } from "./seed.js";
export {
  editYaml,
  freeTextWithDefault,
  squareIntoSquareHole,
  yesNo,
  type Choice,
  type EditorOptions,
  type PromptMode,
  type PromptOptions,
} from "./prompts.js";
export type {
  DetectionResult,
  HookCapability,
  SensorProposal,
  StackKind,
  StackSignature,
  StartCommand,
} from "./types.js";
export { buildRepoSummary } from "./walker.js";
export type {
  BuildRepoSummaryOptions,
  ManifestPreview,
  RepoSummary,
} from "./walker.js";
export { updateWorkflowSlugBlock } from "./workflow-block.js";
export type {
  UpdateResult as WorkflowSlugUpdateResult,
  WorkflowSlugBlockUpdate,
} from "./workflow-block.js";
export {
  PHASE_IDS,
  INIT_STATE_PATH,
  phaseStateAbsPath,
  readPhaseState,
  writePhaseState,
  clearPhaseState,
  freshPhaseState,
  resumePhases,
  nextPhaseAfter,
  advancePhase,
} from "./phases/index.js";
export type {
  PhaseId,
  PhaseState,
  PhaseOutputs,
  PhaseResult,
  PhaseQuestion,
  PhaseOption,
  PhaseError,
  ResumeReport,
} from "./phases/index.js";
