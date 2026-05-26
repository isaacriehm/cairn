#!/usr/bin/env node
/**
 * Bin entrypoint — `node cairn-core/dist/hooks/ask-user-blocked.js`.
 * PostToolUse on AskUserQuestion; stamps the active task's status.yaml
 * with `blocked_on: operator` so the Stop hook's stalled-task scanner
 * skips it while the operator answers.
 */

import { runAskUserBlockedHook } from "./post-tool-use/index.js";

runAskUserBlockedHook().catch((err: unknown) => {
  process.stderr.write(
    `[cairn ask-user-blocked] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
