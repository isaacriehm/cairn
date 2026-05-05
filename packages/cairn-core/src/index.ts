/**
 * @isaacriehm/cairn-core — state + context-loading layer.
 *
 * See docs/ARCHITECTURE.md §3.1.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// VERSION is the single source of truth for what `cairn --version` prints,
// what gets stamped into `.cairn/config.yaml`'s `cairn_version`, and what
// the bootstrap-guard reports back to the operator. Read from package.json
// at module load so it can never drift from the published artifact.
//
// Layout: this file ships as `dist/index.js`; package.json is one level up.
const _here = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(
  readFileSync(join(_here, "..", "package.json"), "utf8"),
) as { version: string };
export const VERSION: string = _pkg.version;

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
