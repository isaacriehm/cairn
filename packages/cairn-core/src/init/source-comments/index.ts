export {
  HEURISTIC,
  detectLang,
  walkSourceComments,
} from "./walker.js";
export type {
  WalkOptions,
  WalkResult,
} from "./walker.js";
export { classifyBlocks } from "./classify.js";
export type {
  ClassifyArgs,
  ClassifyResult,
  CommentClassKind,
  CommentClassification,
} from "./classify.js";
export { runSourceCommentsIngestion } from "./ingest.js";
export type {
  IngestSourceCommentsArgs,
  IngestSourceCommentsResult,
} from "./ingest.js";
export {
  applyStripReplace,
  formatBareCitation,
  previewStripReplace,
} from "./strip-replace.js";
export type {
  DirtyDecision,
  FileOutcome,
  ReplaceItem,
  SkipReason,
  StripReplaceArgs,
  StripReplaceResult,
} from "./strip-replace.js";
