#!/usr/bin/env node
/**
 * Bin entrypoint — `node harness-core/dist/hooks/session-start.js`.
 * Plugin manifest references this directly so harness-frontend-claudecode
 * doesn't depend on the `harness` umbrella CLI being on PATH.
 */

import { runSessionStartHook } from "./runners/index.js";

runSessionStartHook().catch((err: unknown) => {
  process.stderr.write(
    `[harness session-start] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
