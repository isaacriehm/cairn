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
// the bootstrap-guard reports back to the operator. In the npm-published
// dist/ layout, read from package.json one level up. In the Claude Code
// plugin bundle, esbuild bakes the value via --define so the bundle has
// no runtime dependency on package.json's location.
function readVersion(): string {
  if (typeof __CAIRN_VERSION__ === "string") return __CAIRN_VERSION__;
  const _here = dirname(fileURLToPath(import.meta.url));
  try {
    const raw = readFileSync(join(_here, "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {
    /* fallback to unknown */
  }
  return "unknown";
}
export const VERSION: string = readVersion();

export { logger, setLogFile, setLogNull, setLogStderr } from "./logger.js";
export {
  withWriteLock,
  acquireOperationLock,
  OperationLockHeldError,
} from "./lock.js";
export type { WithLockOptions } from "./lock.js";

export * from "./attention/index.js";
export * from "./components/index.js";
export * from "./claude/index.js";
export * from "./context/index.js";
export * from "./decision-capture/index.js";
export * from "./doctor/index.js";
export * from "./gc/index.js";
export * from "./state/rebuild-derived.js";
export * from "@isaacriehm/cairn-state";
export {
  clearDeferState,
  deferStatePath,
  isDeferActive,
  readDeferState,
  writeDeferState,
} from "./hooks/defer.js";
export type { DeferKind, DeferState } from "./hooks/defer.js";
export * from "./align-undo/index.js";
export * from "./drain/index.js";
export * from "./fix-align/index.js";
export * from "./hooks/post-tool-use/index.js";
export * from "./hooks/pre-commit/index.js";
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
export * from "./missions/index.js";
export {
  appendTrace,
  nowEvent,
  traceDir,
  traceFilePath,
  type TraceEvent,
  type TraceSource,
} from "./trace/index.js";
export { jaccard, tokenize } from "./text/jaccard.js";
