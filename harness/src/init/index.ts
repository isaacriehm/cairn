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
  RunMapperArgs,
} from "./mapper.js";
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
