#!/usr/bin/env node
/**
 * Bin entrypoint — `node harness-core/dist/hooks/stop.js`.
 */

import { runStopHook } from "./runners/index.js";

runStopHook().catch((err: unknown) => {
  process.stderr.write(
    `[harness stop] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
