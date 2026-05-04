#!/usr/bin/env node
/**
 * Bin entrypoint — `node harness-core/dist/hooks/session-end.js`.
 */

import { runSessionEndHook } from "./runners/index.js";

runSessionEndHook().catch((err: unknown) => {
  process.stderr.write(
    `[harness session-end] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
