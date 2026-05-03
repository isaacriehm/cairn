/**
 * Phase 13 — backprop protocol.
 *
 * After a code-class run lands its fix, the backprop subagent reads the
 * tightened spec + diff + failure that motivated the fix, distills a
 * permanent §V invariant, and emits a sensor (or named E2E case) that
 * catches a regression of that invariant on every future run.
 *
 * Public surface:
 *   - runBackprop(args)              → writes invariant + sensor, returns result
 *   - allocateInvariantId(repoRoot)  → next monotonic V-id
 *   - writeInvariantArtifacts(args)  → mechanical writer (used by runBackprop)
 *   - BACKPROP_OUTPUT_SCHEMA, BACKPROP_SYSTEM_PROMPT — for consumers that
 *     want to call `runClaude` directly (smoke convenience).
 */

export type {
  BackpropInput,
  BackpropOutput,
  BackpropResult,
  EnforcementKind,
} from "./types.js";

export { allocateInvariantId } from "./id.js";
export {
  BACKPROP_SYSTEM_PROMPT,
  buildBackpropUserPrompt,
} from "./prompt.js";
export { BACKPROP_OUTPUT_SCHEMA } from "./schema.js";
export { runBackprop } from "./runner.js";
export type { RunBackpropArgs } from "./runner.js";
export {
  writeInvariantArtifacts,
} from "./writer.js";
export type {
  WriteInvariantArgs,
  WriteInvariantResult,
} from "./writer.js";
