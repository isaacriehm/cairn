/**
 * Combined PostToolUse hook for Write/Edit tools.
 *
 * Merges the Write Guardian (safety/scope hints) and Layer A alignment
 * into a single runner. This saves ~300ms of Node/CLI boot overhead
 * by running both logically sequential tasks in a single process.
 */

import { relative, resolve } from "node:path";
import { resolveRepoRoot } from "../../session-start/index.js";
import { appendTouched } from "../../session/index.js";
import { readHookStdin, parseHookPayload, resolveHookCwd, normalizePostToolUse, pickWrittenContent } from "../runners/payload.js";
import { writePostToolUseBlock, writePostToolUseOutput } from "../hook-platform.js";
import { executeSotAlign } from "./sot-align.js";
import { executeWriteGuardian } from "./write-guardian.js";
import { runComponentFreshness } from "../../components/freshness.js";
import { logger } from "../../logger.js";

const log = logger("hooks.post-tool-use.post-write");

export async function runPostWriteHook(): Promise<void> {
  try {
    const raw = await readHookStdin();
    const hookPayload = parseHookPayload(raw);
    const payload = normalizePostToolUse(hookPayload);

    const tool = payload.tool_name;
    if (tool !== "Write" && tool !== "Edit") {
      writePostToolUseOutput("");
      return;
    }

    const filePath = payload.tool_input?.file_path;
    if (filePath === undefined || filePath.length === 0) {
      writePostToolUseOutput("");
      return;
    }

    const cwd = resolveHookCwd(hookPayload);
    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot === null) {
      writePostToolUseOutput("");
      return;
    }

    const content = pickWrittenContent(payload.tool_name, payload.tool_input) ?? "";
    // filePath from the Claude Code payload is absolute. Guardian's
    // gitignore / glob / scope-index lookups all expect a repo-relative
    // path, so normalize here before handing it over.
    const relPath = relative(repoRoot, resolve(cwd, filePath));

    // Stage-3 (D6): record the touched path so the Stop capture-gate can
    // later filter to component-dir files missing a @cairn header. Best-
    // effort, before the guard block — PostToolUse fires after the write
    // landed, so the file is on disk regardless of the guard hint.
    const sessionId =
      typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : null;
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
      payload,
    });
    if (guard.kind === "block") {
      writePostToolUseBlock(guard.message ?? "blocked");
      return;
    }

    // 2. Run SoT Align (hint only)
    const alignSummary = await executeSotAlign(payload, repoRoot);

    // 3. Ghost component freshness gate (§3.8.1). Deterministic, NO LLM —
    //    detects an identity-relevant change to a registered headerless
    //    component and flags it for a (deferred) re-confirm. `isGhost`-gated
    //    inside, so committed repos pay nothing. Best-effort: a failure here
    //    must never affect the Write.
    let freshnessHint = "";
    try {
      const fr = runComponentFreshness(repoRoot, relPath);
      if (fr.hint) freshnessHint = fr.hint;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "component freshness gate threw; ignoring",
      );
    }

    // 4. Merge and Emit
    const sections: string[] = [];
    if (guard.message) sections.push(guard.message);
    if (alignSummary.length > 0) sections.push(alignSummary);
    if (freshnessHint.length > 0) sections.push(freshnessHint);

    writePostToolUseOutput(sections.join("\n\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message },
      "Post-write hook failed; degrading to no-op",
    );
    writePostToolUseOutput("");
  }
}
