/**
 * Context module — handoff builder, spec-delta computation, active-task
 * summary. Consumed by the SessionStart Section-0 injector + statusline.
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §2.2 (handoff) + §10 (spec delta).
 */

export { buildHandoffBlock } from "./handoff-builder.js";
export { buildSpecDelta } from "./spec-delta.js";
export type { SpecDelta } from "./spec-delta.js";
export { readActiveTaskSummary } from "./task-summary.js";
export type { ActiveTaskSummary } from "./task-summary.js";
export { buildWorkingHeader } from "./working-header.js";
export type { WorkingHeader } from "./working-header.js";
