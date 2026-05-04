#!/usr/bin/env node
/**
 * Bin entrypoint — `node harness-core/dist/hooks/read-enrich.js`.
 * PostToolUse on Read; injects citation legend.
 */

import { runReadEnricher } from "./post-tool-use/index.js";

runReadEnricher().catch((err: unknown) => {
  process.stderr.write(
    `[harness read-enrich] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
