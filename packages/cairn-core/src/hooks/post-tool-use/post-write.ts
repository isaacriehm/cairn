/**
 * Combined PostToolUse hook for Write/Edit tools.
 *
 * Merges the Write Guardian (safety/scope hints) and Layer A alignment
 * into a single runner. This saves ~300ms of Node/CLI boot overhead
 * by running both logically sequential tasks in a single process.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { resolveRepoRoot } from "../../session-start/index.js";
import { appendTouched } from "../../session/index.js";
import {
  extractWrittenPaths,
  normalizePostToolUse,
  parseHookPayload,
  pickWrittenContent,
  readHookStdin,
  resolveHookCwd,
} from "../runners/payload.js";
import {
  resolveAgentHost,
  writePostToolUseBlock,
  writePostToolUseOutput,
  type HookRunOptions,
} from "../hook-platform.js";
import { executeSotAlign } from "./sot-align.js";
import { executeWriteGuardian } from "./write-guardian.js";
import { runComponentFreshness } from "../../components/freshness.js";
import { logger } from "../../logger.js";

const log = logger("hooks.post-tool-use.post-write");

export async function runPostWriteHook(options: HookRunOptions = {}): Promise<void> {
  const host = resolveAgentHost(options.host);
  try {
    const raw = await readHookStdin();
    const hookPayload = parseHookPayload(raw);
    const payload = normalizePostToolUse(hookPayload);

    const tool = payload.tool_name;
    if (tool !== "Write" && tool !== "Edit" && tool !== "apply_patch") {
      writePostToolUseOutput(host, "");
      return;
    }

    const filePaths = extractWrittenPaths(tool, payload.tool_input);
    if (filePaths.length === 0) {
      writePostToolUseOutput(host, "");
      return;
    }

    const cwd = resolveHookCwd(hookPayload);
    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot === null) {
      writePostToolUseOutput(host, "");
      return;
    }

    const sessionId =
      typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : null;

    const sections: string[] = [];
    const blocks: string[] = [];
    for (const filePath of filePaths) {
      const absolutePath = resolve(cwd, filePath);
      const relPath = relative(repoRoot, absolutePath);
      const content =
        tool === "apply_patch"
          ? existsSync(absolutePath)
            ? readFileSync(absolutePath, "utf8")
            : ""
          : pickWrittenContent(payload.tool_name, payload.tool_input) ?? "";
      const filePayload =
        tool === "apply_patch"
          ? {
              ...payload,
              tool_name: "Edit",
              tool_input: {
                ...payload.tool_input,
                file_path: filePath,
                content,
              },
            }
          : payload;

      // Record every path changed by a multi-file Codex apply_patch.
      if (sessionId !== null) {
        try {
          appendTouched(repoRoot, sessionId, relPath);
        } catch {
          // best-effort — never affect the write
        }
      }

      const guard = executeWriteGuardian({
        repoRoot,
        relPath,
        content,
        payload: filePayload,
      });
      if (guard.kind === "block") {
        blocks.push(guard.message ?? `blocked: ${relPath}`);
        continue;
      }
      if (guard.message) sections.push(guard.message);

      const alignSummary = await executeSotAlign(filePayload, repoRoot);
      if (alignSummary.length > 0) sections.push(alignSummary);

      // Ghost component freshness gate (§3.8.1). Deterministic and
      // best-effort; committed repos pay nothing.
      try {
        const freshness = runComponentFreshness(repoRoot, relPath);
        if (freshness.hint) sections.push(freshness.hint);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), relPath },
          "component freshness gate threw; ignoring",
        );
      }
    }

    if (blocks.length > 0) {
      writePostToolUseBlock(host, blocks.join("\n\n"));
      return;
    }
    writePostToolUseOutput(host, [...new Set(sections)].join("\n\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message },
      "Post-write hook failed; degrading to no-op",
    );
    writePostToolUseOutput(host, "");
  }
}
