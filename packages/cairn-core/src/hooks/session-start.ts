#!/usr/bin/env node
/**
 * Bin entrypoint — `node cairn-core/dist/hooks/session-start.js`.
 * Plugin manifest references this directly so cairn-frontend-claudecode
 * doesn't depend on the `cairn` umbrella CLI being on PATH.
 */

import { runSessionStartHook } from "./runners/index.js";

runSessionStartHook().catch((err: unknown) => {
  process.stderr.write(
    `[cairn session-start] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
