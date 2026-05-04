export {
  HEURISTIC,
  detectLang,
  walkSourceComments,
} from "./walker.js";
export type {
  CommentBlock,
  CommentKind,
  CommentLang,
  WalkOptions,
  WalkResult,
} from "./walker.js";
export {
  classifyBlocks,
  _internal as _classifyInternal,
} from "./classify.js";
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
  previewStripReplace,
  _internal as _stripReplaceInternal,
} from "./strip-replace.js";
export type {
  DirtyDecision,
  FileOutcome,
  ReplaceItem,
  SkipReason,
  StripReplaceArgs,
  StripReplaceResult,
} from "./strip-replace.js";
