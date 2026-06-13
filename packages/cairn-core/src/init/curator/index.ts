export {
  validateEntry,
  filterExistingEvidence,
  stripLineRange,
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
