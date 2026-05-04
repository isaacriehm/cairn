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
 * Used by the CLI (`harness gc run`) and the smoke test
 * (`harness/scripts/smoke-gc.ts`). Future cron / `/loop` integration consumes
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
  CanarySyntheticContext,
} from "./types.js";

export { applyCommit } from "./apply.js";
export type { ApplyCommitOptions, ApplyCommitResult } from "./apply.js";
export {
  verifyBatchCanary,
  buildSyntheticContext,
} from "./canary.js";
export type {
  BatchCanaryResult,
  BatchCanaryOptions,
} from "./canary.js";
export { classifyAutoMerge } from "./classify.js";
export type { ClassifyArgs } from "./classify.js";
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
export { runQualityGradesUpdate } from "./quality-update.js";
export type {
  QualityUpdateOptions,
  QualityUpdateResult,
} from "./quality-update.js";
export { runStubCatalogHits } from "./stub-hits.js";
export type {
  StubCatalogHitsOptions,
  StubCatalogHitsResult,
} from "./stub-hits.js";
export { runGcBatch, runGcSweep } from "./sweep.js";
export type {
  RunGcBatchOptions,
  RunGcSweepOptions,
} from "./sweep.js";
