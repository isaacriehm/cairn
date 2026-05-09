/**
 * Combined PostToolUse hook for Write/Edit tools.
 *
 * Merges the Write Guardian (safety/scope hints) and Layer A alignment
 * into a single runner. This saves ~300ms of Node/CLI boot overhead
 * by running both logically sequential tasks in a single process.
 */

import { resolveRepoRoot } from "../../session-start/index.js";
import { readHookStdin } from "../runners/payload.js";
import { executeSotAlign } from "./sot-align.js";
import { executeWriteGuardian } from "./write-guardian.js";
import { logger } from "../../logger.js";

const log = logger("hooks.post-tool-use.post-write");

interface PostToolUseShapeBOutput {
  continue: true;
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext: string;
  };
}

interface PostToolUseBlockOutput {
  continue: false;
  decision: "block";
  reason: string;
}

interface ClaudePostToolUsePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    new_string?: string;
    [key: string]: unknown;
  };
  tool_response?: {
    content?: string;
    text?: string;
    output?: string;
    [key: string]: unknown;
  };
}

function parsePayload(text: string): ClaudePostToolUsePayload {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as ClaudePostToolUsePayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function emitShapeB(additionalContext: string): void {
  const out: PostToolUseShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

function emitBlock(reason: string): void {
  const out: PostToolUseBlockOutput = {
    continue: false,
    decision: "block",
    reason,
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

export async function runPostWriteHook(): Promise<void> {
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);

    const tool = payload.tool_name;
    if (tool !== "Write" && tool !== "Edit") {
      emitShapeB("");
      return;
    }

    const filePath = payload.tool_input?.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      emitShapeB("");
      return;
    }

    const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    // 1. Run Guardian (can block)
    const guard = await executeWriteGuardian(payload, repoRoot);
    if (guard.kind === "block") {
      emitBlock(guard.message ?? "blocked");
      return;
    }

    // 2. Run SoT Align (hint only)
    const alignSummary = await executeSotAlign(payload, repoRoot);

    // 3. Merge and Emit
    const sections: string[] = [];
    if (guard.message) sections.push(guard.message);
    if (alignSummary) sections.push(alignSummary);

    emitShapeB(sections.join("\n\n"));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Post-write hook failed; degrading to no-op",
    );
    emitShapeB("");
  }
}
