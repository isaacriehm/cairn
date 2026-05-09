/**
 * Layer C — `cairn fix align` (plan §4.4) barrel.
 */

export { runFixAlign } from "./run.js";
export type {
  FixAlignArgs,
  FixAlignResult,
  PreflightResult,
  AggregateAlignResult,
} from "./run.js";
export {
  fixAlignSentinelPath,
  gitDirtyPathsInScope,
  hashFixAlignArgs,
  readGitHeadSha,
  validateFixAlignSentinel,
  writeFixAlignSentinel,
} from "./sentinel.js";
export type {
  DirtyPath,
  FixAlignSentinelArgs,
  SentinelValidation,
} from "./sentinel.js";
