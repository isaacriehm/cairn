/**
 * Phase 12 — garbage collection cadence.
 *
 * Public surface:
 *   - runGcSweep(opts)          → composes all five passes
 *   - runGcBatch(opts)          → sweep + classify + apply + canary
 *   - applyCommit(opts)         → apply a single proposal
 *   - verifyBatchCanary(opts)   → standalone canary check
 *   - classifyAutoMerge(args)   → safe | code | high-stakes
 *   - runFrontmatterFreshness, runGeneratorDrift, runStubCatalogHits,
 *     runDocGardening, runQualityGradesUpdate — direct pass entry points
 *
 * Used by the CLI (`cairn gc run`) and the smoke test
 * (`cairn/scripts/smoke-gc.ts`). Future cron / `/loop` integration consumes
 * the same surface.
 */

export type {
  GcAutoMergeClass,
  GcBatchResult,
  GcCommitProposal,
  GcFinding,
  GcFindingKind,
  GcPassId,
  GcSweepResult,
} from "./types.js";

export { applyCommit } from "./apply.js";
export type { ApplyCommitOptions, ApplyCommitResult } from "./apply.js";
export { runGcCanary as verifyBatchCanary } from "./canary.js";
export type {
  GcCanaryResult as BatchCanaryResult,
  GcCanaryOptions as BatchCanaryOptions,
} from "./canary.js";
export { runCitationIntegrity } from "./citation-integrity.js";
export { classifyAutoMerge } from "./classify.js";
export type { ClassifyArgs } from "./classify.js";
export { runCompletionIntegrity } from "./completion-integrity.js";
export type {
  CompletionIntegrityOptions,
  CompletionIntegrityResult,
} from "./completion-integrity.js";
export { runDocGardening } from "./doc-gardening.js";
export type {
  DocGardeningOptions,
  DocGardeningResult,
} from "./doc-gardening.js";
export {
  runFrontmatterFreshness,
} from "./frontmatter.js";
export type {
  FrontmatterFreshnessOptions,
  FrontmatterFreshnessResult,
} from "./frontmatter.js";
export { runGeneratorDrift } from "./generator-drift.js";
export type {
  GeneratorDriftOptions,
  GeneratorDriftResult,
} from "./generator-drift.js";
export { runQualityUpdate as runQualityGradesUpdate } from "./quality-update.js";
export type {
  QualityUpdateOptions,
} from "./quality-update.js";
export { runAttestedCommitsGc } from "./attested-commits.js";
export type {
  AttestedCommitsGcOptions,
  AttestedCommitsGcResult,
} from "./attested-commits.js";
export { runScopeCoverage } from "./scope-coverage.js";
export type {
  ScopeCoverageOptions,
  ScopeCoverageResult,
} from "./scope-coverage.js";
export { runStubCatalogHits } from "./stub-hits.js";
export type {
  StubCatalogHitsOptions,
} from "./stub-hits.js";
export { runGcBatch, runGcSweep } from "./sweep.js";
export type {
  RunGcBatchOptions,
  RunGcSweepOptions,
} from "./sweep.js";
export { walkSourceTree, SOURCE_TREE_SKIP_DIRS } from "./walk-source.js";
