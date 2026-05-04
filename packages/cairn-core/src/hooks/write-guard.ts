#!/usr/bin/env node
/**
 * Bin entrypoint — `node harness-core/dist/hooks/write-guard.js`.
 * PostToolUse on Write/Edit; copy-safety + scope reminder.
 */

import { runWriteGuardian } from "./post-tool-use/index.js";

runWriteGuardian().catch((err: unknown) => {
  process.stderr.write(
    `[harness write-guard] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
