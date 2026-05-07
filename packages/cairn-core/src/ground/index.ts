export {
  CANONICAL_GLOBS,
  CANONICAL_EXCLUDES,
  alignmentPendingDir,
  anchorMapPath,
  archivedConflictsDir,
  conflictsDir,
  decisionsDir,
  decisionsLedgerPath,
  groundDir,
  haikuCacheDir,
  invariantsDir,
  invariantsLedgerPath,
  manifestPath,
  qualityGradesPath,
  runsTerminalDir,
  sotBindingsPath,
  sotCachePath,
  sotRenderedCacheDir,
  layerADeferredLogPath,
  preCommitDeferredLogPath,
  stalenessCurrentPath,
  stalenessDir,
  stalenessLogPath,
  topicIndexPath,
} from "./paths.js";
export { matchGlob, matchAnyGlob, compileGlob } from "./glob.js";
export { walkCanonical } from "./walk.js";
export { parseFrontmatter, parseFrontmatterRecord, readFrontmatter, evaluateFreshness } from "./frontmatter.js";
export type { ParsedDocument, FreshnessVerdict } from "./frontmatter.js";
export { buildManifest, writeManifest } from "./manifest.js";
export type { BuildManifestOptions } from "./manifest.js";
export {
  buildDecisionsLedger,
  buildInvariantsLedger,
  writeDecisionsLedger,
  writeInvariantsLedger,
} from "./ledgers.js";
export type { LedgerOptions } from "./ledgers.js";
export { recordDriftEvent, writeDriftSnapshot } from "./drift.js";
export type { DriftSnapshot } from "./drift.js";
export { writeAlignmentPending } from "./alignment-pending.js";
export type {
  AlignmentPendingKind,
  WriteAlignmentPendingArgs,
} from "./alignment-pending.js";
export { buildQualityGrades, writeQualityGrades } from "./quality-grades.js";
export type { QualityGradesOptions } from "./quality-grades.js";
export {
  coerceDecisionIds,
  coerceInvariantIds,
  lookupScope,
  readScopeIndex,
  rebuildScopeIndex,
  rescanScopeIndex,
  scopeIndexPath,
  writeScopeIndex,
} from "./scope-index.js";
export type {
  RebuildScopeIndexOptions,
  RebuildScopeIndexResult,
  RescanScopeIndexResult,
  ScopeIndex,
  ScopeIndexEntry,
} from "./scope-index.js";
export {
  AnchorMap,
  AnchorMapEntry,
  Audience,
  ProvenanceFrontmatter,
  ManifestEntry,
  Manifest,
  DecisionAssertion,
  DecisionFrontmatter,
  InvariantFrontmatter,
  DecisionLedgerEntry,
  InvariantLedgerEntry,
  QualityGrade,
  QualityGrades,
  DriftEvent,
  PreCommitDriftCandidate,
  PreCommitDriftLogEntry,
  SotBindings,
  SotCache,
  SotCacheEntry,
  SotKind,
  TopicIndex,
  TopicIndexEntry,
} from "./schemas.js";

export {
  bindDec,
  decsForPath,
  emptySotBindings,
  pathForDec,
  readSotBindings,
  unbindDec,
  writeSotBindings,
} from "./sot-bindings.js";

export {
  clearDecFromTopicIndex,
  emptyTopicIndex,
  getTopic,
  readTopicIndex,
  setTopic,
  writeTopicIndex,
} from "./topic-index.js";

export {
  deleteEntry as deleteSotCacheEntry,
  emptySotCache,
  entries as sotCacheEntries,
  getEntry as getSotCacheEntry,
  readSotCache,
  setEntry as setSotCacheEntry,
  writeSotCache,
} from "./sot-cache.js";

export {
  deleteAnchor,
  emptyAnchorMap,
  getAnchor,
  readAnchorMap,
  setAnchor,
  writeAnchorMap,
} from "./anchor-map.js";

export {
  bodyContentHash,
  deriveDecId,
  deriveInvId,
  deriveLedgerDecId,
  deriveLedgerInvId,
  normalizeBlock,
  topicSlug,
} from "./slug.js";
