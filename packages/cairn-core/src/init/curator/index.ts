export {
  validateEntry,
  normalizeFinalEntry,
  filterExistingEvidence,
  stripLineRange,
  TITLE_CAP,
  type FinalEntry,
  type ValidationResult,
} from "./validate.js";

export {
  runCuratorEmit,
  type RunCuratorEmitArgs,
  type RunCuratorEmitResult,
} from "./emit.js";

export {
  runCuratorWalker,
  type RunCuratorWalkerArgs,
  type RunCuratorWalkerResult,
} from "./walker.js";
