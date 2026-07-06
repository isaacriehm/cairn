/**
 * Claude Code hook runners — pure logic, called by both bin scripts
 * (`cairn-core/dist/hooks/<event>.js`) and the umbrella CLI
 * (`cairn hook <event>`).
 */

export { runSessionStartHook } from "./session-start.js";
export { runSessionEndHook } from "./session-end.js";
export { runStopHook } from "./stop.js";
export { runUserPromptSubmitHook } from "./user-prompt-submit.js";
export { runGcAutotriggerCheck } from "./gc-autotrigger.js";
export type {
  GcAutotriggerArgv,
  GcAutotriggerOptions,
  GcAutotriggerReason,
  GcAutotriggerResult,
} from "./gc-autotrigger.js";
export {
  renderBypassHint,
  scanBypassedCommits,
} from "../bypass-detection.js";
export type {
  BypassedCommit,
  ScanBypassResult,
} from "../bypass-detection.js";
export { seedAttestedCommits } from "../seed-attested.js";
export type { SeedAttestedResult, SeedAttestedStatus } from "../seed-attested.js";
export {
  CAIRN_HOOK_VERSION,
  emitShapeB,
  parseHookPayload,
  resolveHookCwd,
  readHookStdin,
  appendTelemetry,
  normalizePostToolUse,
  pickWrittenContent,
  pickToolResponseContent,
} from "./payload.js";
export type { ClaudeHookPayload, NormalizedPostToolUsePayload } from "./payload.js";
export {
  setCursorHookMode,
  isCursorHook,
  isCursorOnlyHook,
  emitCursorSessionStart,
  emitPostToolUseOutput,
  writePostToolUseOutput,
  writePostToolUseBlock,
  emitStopOutput,
} from "../hook-platform.js";
