/**
 * @isaacriehm/cairn-core — state + context-loading layer.
 *
 * See docs/ARCHITECTURE.md §3.1.
 */

export const VERSION = "0.0.0";

export { logger, setLogFile, setLogNull, setLogStderr } from "./logger.js";
export {
  withWriteLock,
  acquireOperationLock,
  OperationLockHeldError,
} from "./lock.js";
export type { WithLockOptions } from "./lock.js";

export * from "./claude/index.js";
export * from "./context/index.js";
export * from "./decision-capture/index.js";
export * from "./doctor/index.js";
export * from "./gc/index.js";
export * from "./ground/index.js";
export * from "./hooks/post-tool-use/index.js";
export * from "./init/index.js";
export * from "./join/index.js";
export * from "./mcp/index.js";
export * from "./paths/index.js";
export * from "./profiles/index.js";
export * from "./sensors/index.js";
export * from "./events/index.js";
export * from "./hooks/runners/index.js";
export * from "./session/index.js";
export * from "./session-start/index.js";
export * from "./status-line/index.js";
export * from "./tier0/index.js";
export * from "./tightener/index.js";
export * from "./frontend-types.js";
export { writeInboxRow } from "./inbox.js";
export { loadWorkflowTemplate, renderTemplate } from "./prompt.js";
export type { TemplateContext } from "./prompt.js";
