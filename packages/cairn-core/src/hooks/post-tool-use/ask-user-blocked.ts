/**
 * PostToolUse hook on `AskUserQuestion` — auto-stamps the current active
 * task with `blocked_on: operator` in `.cairn/tasks/active/<id>/status.yaml`
 * so the Stop hook's stalled-task scanner skips it (the work can't
 * progress until the operator answers).
 *
 * Producer pair for the `blocked_on: operator` skip rule in
 * `runners/stop.ts:scanStalledRunningTasks`.
 *
 * No-op when:
 *   - `tool_name !== "AskUserQuestion"` (manifest matcher narrows but
 *     defense-in-depth).
 *   - No active task in `.cairn/tasks/active/`.
 *   - status.yaml missing or unparseable.
 *   - `blocked_on: operator` already present (idempotent).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveRepoRoot } from "../../session-start/index.js";
import { findCurrentActiveTask } from "../../tasks/index.js";
import { readHookStdin } from "../runners/payload.js";
import { logger } from "../../logger.js";

const log = logger("hooks.post-tool-use.ask-user-blocked");

const PayloadSchema = z
  .object({
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    tool_name: z.string().optional(),
  })
  .passthrough();

type Payload = z.infer<typeof PayloadSchema>;

function parsePayload(text: string): Payload {
  if (text.trim().length === 0) return {};
  try {
    const raw: unknown = JSON.parse(text);
    const result = PayloadSchema.safeParse(raw);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

function emitShapeB(additionalContext: string): void {
  const out = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

export async function runAskUserBlockedHook(): Promise<void> {
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);

    if (payload.tool_name !== "AskUserQuestion") {
      emitShapeB("");
      return;
    }

    const cwd = payload.cwd ?? process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    const taskId = findCurrentActiveTask(repoRoot);
    if (taskId === null) {
      emitShapeB("");
      return;
    }

    const statusPath = join(repoRoot, ".cairn", "tasks", "active", taskId, "status.yaml");
    if (!existsSync(statusPath)) {
      emitShapeB("");
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(statusPath, "utf8"));
    } catch {
      emitShapeB("");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      emitShapeB("");
      return;
    }
    const status = parsed as Record<string, unknown>;

    if (status["blocked_on"] === "operator") {
      emitShapeB("");
      return;
    }

    status["blocked_on"] = "operator";
    try {
      writeFileSync(statusPath, stringifyYaml(status), "utf8");
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), taskId },
        "ask-user-blocked: write to status.yaml failed",
      );
    }

    emitShapeB("");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ask-user-blocked hook failed; degrading to no-op",
    );
    emitShapeB("");
  }
}
