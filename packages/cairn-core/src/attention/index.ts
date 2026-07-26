export {
  findDuplicateClusters,
  DEFAULT_THRESHOLD_DEFINITE,
  DEFAULT_THRESHOLD_FLOOR,
  type DraftRef,
  type DuplicateCluster,
  type DedupResult,
} from "./dedup.js";

export {
  parseDraftMeta,
  findLatestSourceCommentsAudit,
  runDecSourceStrip,
  type DraftMeta,
  type StripOutcomeSummary,
} from "./source-strip.js";

export {
  restoreDec,
  type RestoreArgs,
  type RestoreResult,
  type RestoreState,
} from "./restore.js";

export {
  countFindingsBySeverity,
  listPendingDrafts,
  readLatestBaselineAudit,
  readLatestBaselineDetail,
  type AttentionDraftEntry,
  type BaselineAuditDetail,
  type BaselineAuditSummary,
  type BaselineFindingRow,
  type ReadBaselineOptions,
} from "./surface.js";
