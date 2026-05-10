/**
 * Combined PostToolUse hook for Write/Edit tools.
 *
 * Merges the Write Guardian (safety/scope hints) and Layer A alignment
 * into a single runner. This saves ~300ms of Node/CLI boot overhead
 * by running both logically sequential tasks in a single process.
 */

import { z } from "zod";
import { resolveRepoRoot } from "../../session-start/index.js";
import { readHookStdin } from "../runners/payload.js";
import { executeSotAlign } from "./sot-align.js";
import { executeWriteGuardian } from "./write-guardian.js";
import { logger } from "../../logger.js";

const log = logger("hooks.post-tool-use.post-write");

const ClaudePostToolUsePayloadSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.object({
    file_path: z.string().optional(),
    // Edit tool fields
    new_string: z.string().optional(),
    old_string: z.string().optional(),
    // Write tool field
    content: z.string().optional(),
  }).passthrough().optional(),
  tool_response: z.object({
    content: z.string().optional(),
    text: z.string().optional(),
    output: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

type ClaudePostToolUsePayload = z.infer<typeof ClaudePostToolUsePayloadSchema>;

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

function parsePayload(text: string): ClaudePostToolUsePayload {
  if (text.trim().length === 0) return {};
  try {
    const raw: unknown = JSON.parse(text);
    const result = ClaudePostToolUsePayloadSchema.safeParse(raw);
    return result.success ? result.data : {};
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
    if (filePath === undefined || filePath.length === 0) {
      emitShapeB("");
      return;
    }

    const cwd = payload.cwd ?? process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    // 1. Run Guardian (can block)
    // Needs content — extract from tool_response
    const content = payload.tool_response?.content ?? payload.tool_response?.text ?? payload.tool_response?.output ?? "";
    const guard = executeWriteGuardian({
      repoRoot,
      relPath: filePath,
      content,
      payload,
    });
    if (guard.kind === "block") {
      emitBlock(guard.message ?? "blocked");
      return;
    }

    // 2. Run SoT Align (hint only)
    const alignSummary = await executeSotAlign(payload, repoRoot);

    // 3. Merge and Emit
    const sections: string[] = [];
    if (guard.message) sections.push(guard.message);
    if (alignSummary.length > 0) sections.push(alignSummary);

    emitShapeB(sections.join("\n\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message },
      "Post-write hook failed; degrading to no-op",
    );
    emitShapeB("");
  }
}
