// Noise-strip projection. Raw event → ProjectedEvent.
//
// One raw event may yield multiple projected events when its
// message.content is an array (assistant tool_use + text in one
// message, multi-tool-result in one user message, etc.).

import { DEFAULT_TRUNCATE } from "./types.mjs";
import { truncStr, truncArgs, truncResult, projectEdit } from "./truncate.mjs";

/**
 * Project a raw JSONL event into 0..N projected events.
 * @param {Record<string, unknown>} raw
 * @param {import("./types.mjs").TruncatePolicy} [policy]
 * @returns {import("./types.mjs").ProjectedEvent[]}
 */
export function projectEvent(raw, policy = DEFAULT_TRUNCATE) {
  const base = baseFields(raw);
  switch (raw.type) {
    case "user":
      return projectUser(raw, base, policy);
    case "assistant":
      return projectAssistant(raw, base, policy);
    case "system":
      return [projectSystem(raw, base)];
    case "attachment":
      return [{ ...base, kind: "attachment" }];
    case "permission-mode":
      return [{ ...base, kind: "permission", text: String(raw.permissionMode ?? "") }];
    case "ai-title":
      return [{ ...base, kind: "title", text: String(raw.aiTitle ?? "") }];
    case "last-prompt":
      return [{ ...base, kind: "last_prompt", text: truncStr(raw.lastPrompt, policy.text_head, policy.text_tail) }];
    case "file-history-snapshot":
      return [{ ...base, kind: "snapshot" }];
    default:
      return [];
  }
}

function baseFields(raw) {
  return {
    session_id: String(raw.sessionId ?? ""),
    uuid: raw.uuid ? String(raw.uuid) : undefined,
    parent_uuid: raw.parentUuid === undefined ? undefined : raw.parentUuid ?? null,
    ts: raw.timestamp ? String(raw.timestamp) : undefined,
    cwd: raw.cwd ? String(raw.cwd) : undefined,
    git_branch: raw.gitBranch ? String(raw.gitBranch) : undefined,
    cc_version: raw.version ? String(raw.version) : undefined,
  };
}

function projectUser(raw, base, policy) {
  const out = [];
  const content = raw.message?.content;
  if (content == null) return out;
  if (typeof content === "string") {
    out.push({ ...base, kind: "user_text", text: truncStr(content, policy.text_head, policy.text_tail) });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      out.push({ ...base, kind: "user_text", text: truncStr(block.text, policy.text_head, policy.text_tail) });
    } else if (block.type === "tool_result") {
      out.push({
        ...base,
        kind: "tool_result",
        tool_use_id: String(block.tool_use_id ?? ""),
        is_error: Boolean(block.is_error),
        status: block.is_error ? "error" : "ok",
        result_text: truncResult(block.content, policy),
      });
    }
  }
  return out;
}

function projectAssistant(raw, base, policy) {
  const out = [];
  const content = raw.message?.content;
  const usage = raw.message?.usage;
  const tokenFields = usage
    ? {
        tok_in: usage.input_tokens,
        tok_out: usage.output_tokens,
        cache_read: usage.cache_read_input_tokens,
        cache_create: usage.cache_creation_input_tokens,
      }
    : {};
  if (content == null) return out;
  if (typeof content === "string") {
    out.push({ ...base, ...tokenFields, kind: "assistant_text", text: truncStr(content, policy.text_head, policy.text_tail) });
    return out;
  }
  if (!Array.isArray(content)) return out;
  let firstBlock = true;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const tokens = firstBlock ? tokenFields : {};
    firstBlock = false;
    if (block.type === "text") {
      out.push({ ...base, ...tokens, kind: "assistant_text", text: truncStr(block.text, policy.text_head, policy.text_tail) });
    } else if (block.type === "thinking") {
      out.push({ ...base, ...tokens, kind: "thinking", text: truncStr(block.thinking, policy.text_head, policy.text_tail) });
    } else if (block.type === "tool_use") {
      const tool = String(block.name ?? "");
      const edit = projectEdit(tool, block.input ?? {}, policy);
      out.push({
        ...base,
        ...tokens,
        kind: "tool_use",
        tool,
        tool_use_id: String(block.id ?? ""),
        args: edit ? undefined : truncArgs(block.input ?? {}, policy),
        edit,
      });
    }
  }
  return out;
}

function projectSystem(raw, base) {
  return {
    ...base,
    kind: "system",
    subtype: raw.subtype ? String(raw.subtype) : undefined,
    dur_ms: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
    hook_count: typeof raw.hookCount === "number" ? raw.hookCount : undefined,
    hook_errors: Array.isArray(raw.hookErrors) && raw.hookErrors.length > 0 ? raw.hookErrors.map((e) => String(e)) : undefined,
    text: raw.stopReason ? String(raw.stopReason) : undefined,
  };
}

/**
 * Convenience: stream + project in one shot.
 * @param {string} path
 * @param {import("./types.mjs").TruncatePolicy} [policy]
 */
export async function* projectStream(path, policy = DEFAULT_TRUNCATE) {
  const { streamEvents } = await import("./parse.mjs");
  for await (const raw of streamEvents(path)) {
    for (const proj of projectEvent(raw, policy)) yield proj;
  }
}
