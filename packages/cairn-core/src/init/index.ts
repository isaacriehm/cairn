export {
  detectAll,
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
export { detectComponentsConfig, ensureComponentsConfig } from "./detect-components.js";
export type {
  EnsureComponentsConfigResult,
  EnsureComponentsStatus,
} from "./detect-components.js";
export {
  ensureCairnRuleImport,
  installCairnRuleAndImport,
  CAIRN_RULE_IMPORT,
} from "./claude-rule.js";
export type { EnsureImportResult, InstallRuleResult } from "./claude-rule.js";
export type {
  BrandAnswers,
  RunBrandSetupOptions,
} from "./brand-setup.js";
export {
  deriveBrandFromProject,
  derivedToBrandAnswers,
} from "./brand-derive.js";
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
  runStage1FileFilter,
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
  WalkOptions as SourceCommentWalkOptions,
  WalkResult as SourceCommentWalkResult,
} from "./source-comments/index.js";
export type {
  ClassifiedDoc,
  DocCandidate,
  DocClassification,
  DocClassificationKind,
  FileFilterVerdict,
  IngestionResult,
  IngestionRunResult,
  IngestionSkippedResult,
  RunDocsIngestionArgs,
} from "./ingest-docs.js";
export { runInit } from "./init.js";
export type { InitResult, RunInitArgs } from "./init.js";
export { applyPostInitGitConfig, detectWsl } from "./post-git-init.js";
export type {
  GitRunResult,
  GitRunner,
  PostGitInitOptions,
  PostGitInitResult,
  WslDetectOptions,
} from "./post-git-init.js";
export {
  SKILL_BUDGET_FLOOR,
  ensureSkillBudgetFloor,
  settingsJsonPath,
} from "./skill-budget.js";
export type {
  EnsureSkillBudgetOptions,
  EnsureSkillBudgetOutcome,
  EnsureSkillBudgetResult,
} from "./skill-budget.js";
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
  MapperResult,
  MapperScopeIndex,
  MapperScopeIndexEntry,
  RunMapperArgs,
} from "./mapper.js";
export {
  PROGRESS_PATH,
  progressAbsPath,
  writeProgress,
  readProgress,
  clearProgress,
  type ProgressSnapshot,
} from "./progress.js";
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
  MAPPER_OUTPUT_PATH,
  mapperOutputAbsPath,
  readMapperOutputFile,
  writeMapperOutputFile,
  toMapperResultPersisted,
  runPhase1Detect,
  runPhase2Walker,
  runPhase3Mapper,
  runPhase4Seed,
  runPhase5Preflight,
  runPhase6Brand,
  runPhase7TopicIndex,
  runPhase8DocsIngest,
  runPhase9aWalker,
  runPhase9bCurate,
  runPhase9cEmit,
  CURATOR_FINAL_PATH,
  runPhase9dCompWalk,
  COMP_MISSING_PATH,
  runPhase9eCompAnnotate,
  runPhase9fCompEmit,
  runPhase10RulesMerge,
  runPhase11Baseline,
  runPhase13Multidev,
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
  MapperResultPersisted,
  WalkerOutput,
  CurateOutput,
  EmitOutput,
  CompWalkOutput,
  CompAnnotateOutput,
  ComponentsPhaseOutput,
  NoopPhaseOutput,
  TopicIndexPhaseOutput,
} from "./phases/index.js";

export {
  validateEntry,
  filterExistingEvidence,
  stripLineRange,
  type FinalEntry,
  type ValidationResult,
  runCuratorEmit,
  type RunCuratorEmitArgs,
  type RunCuratorEmitResult,
  runCuratorWalker,
  type RunCuratorWalkerArgs,
  type RunCuratorWalkerResult,
} from "./curator/index.js";

export {
  buildTopicIndex,
  walkProseBlocks,
  resolveTopics,
  makeHaikuJudge,
} from "./topic-index/index.js";
export type {
  BuildTopicIndexArgs,
  BuildTopicIndexResult,
  ProseBlock,
  ProseBlockKind,
  ResolveOptions,
  ResolveResult,
  SemanticJudge,
  SemanticVerdict,
  JudgeOptions,
} from "./topic-index/index.js";
