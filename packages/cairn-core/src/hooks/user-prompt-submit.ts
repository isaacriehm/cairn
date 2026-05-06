#!/usr/bin/env node
/**
 * Bin entrypoint — `node cairn-core/dist/hooks/user-prompt-submit.js`.
 * UserPromptSubmit hook; resolves §INV/§DEC/TODO(TSK-) citations in
 * `@`-attached files (Read-bypass path).
 */

import { runUserPromptSubmitHook } from "./runners/index.js";

runUserPromptSubmitHook().catch((err: unknown) => {
  process.stderr.write(
    `[cairn user-prompt-submit] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
