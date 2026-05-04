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
export type {
  ClassifiedDoc,
  DocCandidate,
  DocClassification,
  DocClassificationKind,
  IngestionResult,
  RunDocsIngestionArgs,
} from "./ingest-docs.js";
export { tryStartDaemon } from "./daemon-autostart.js";
export type { DaemonAutostartResult } from "./daemon-autostart.js";
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
export { runLegacyMapper } from "./mapper-legacy.js";
export type { RunLegacyMapperArgs } from "./mapper-legacy.js";
export { seedHarnessLayout, templatesRoot } from "./seed.js";
export type { SeedOptions, SeedResult } from "./seed.js";
export {
  editYaml,
  freeTextWithDefault,
  secretInput,
  squareIntoSquareHole,
  yesNo,
  type Choice,
  type EditorOptions,
  type PromptMode,
  type PromptOptions,
} from "./prompts.js";
export {
  harnessEnvPath,
  readHarnessEnv,
  upsertHarnessEnv,
} from "./secrets.js";
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
