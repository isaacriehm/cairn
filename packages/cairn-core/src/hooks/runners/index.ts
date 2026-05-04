/**
 * Claude Code hook runners — pure logic, called by both bin scripts
 * (`harness-core/dist/hooks/<event>.js`) and the umbrella CLI
 * (`harness hook <event>`).
 */

export { runSessionStartHook } from "./session-start.js";
export { runSessionEndHook } from "./session-end.js";
export { runStopHook } from "./stop.js";
export {
  renderBypassHint,
  scanBypassedCommits,
} from "../bypass-detection.js";
export type {
  BypassedCommit,
  ScanBypassResult,
} from "../bypass-detection.js";
export {
  HARNESS_HOOK_VERSION,
  emitShapeB,
  parseHookPayload,
  readHookStdin,
  recordHookTelemetry,
} from "./payload.js";
export type { ClaudeHookPayload, HookTelemetryRow } from "./payload.js";
