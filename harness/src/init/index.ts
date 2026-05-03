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
export { seedCairnLayout, templatesRoot } from "./seed.js";
export type { SeedOptions, SeedResult } from "./seed.js";
export {
  freeTextWithDefault,
  squareIntoSquareHole,
  type Choice,
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
