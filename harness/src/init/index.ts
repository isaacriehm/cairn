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
export { seedHarnessLayout, templatesRoot } from "./seed.js";
export type { SeedOptions, SeedResult } from "./seed.js";
export {
  freeTextWithDefault,
  secretInput,
  squareIntoSquareHole,
  yesNo,
  type Choice,
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
