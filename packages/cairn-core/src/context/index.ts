/**
 * Context module — handoff builder, checkpoint writer, and spec-delta
 * computation. Consumed by the SessionStart Section-0 injector and the
 * orchestrator daemon.
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §2.2 (handoff) + §10 (spec delta).
 */

export { buildHandoffBlock } from "./handoff-builder.js";
export { writeCheckpoint } from "./checkpoint.js";
export { buildSpecDelta } from "./spec-delta.js";
export type { SpecDelta } from "./spec-delta.js";
