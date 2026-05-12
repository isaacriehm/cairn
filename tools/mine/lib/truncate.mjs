// Head+tail+marker truncation helpers.

import { NEVER_TRUNCATE_ARG_KEYS } from "./types.mjs";

/**
 * Truncate a string with head + tail + marker.
 * Returns original if length <= head + tail.
 * @param {unknown} s
 * @param {number} head
 * @param {number} tail
 * @returns {string|undefined}
 */
export function truncStr(s, head, tail) {
  if (s == null) return undefined;
  const str = typeof s === "string" ? s : String(s);
  if (str.length <= head + tail) return str;
  const removed = str.length - (head + tail);
  return str.slice(0, head) + `...[+${removed}ch]...` + str.slice(-tail);
}

/**
 * Truncate by lines with head + tail + marker. Used for diffs.
 * @param {string} s
 * @param {number} headLines
 * @param {number} tailLines
 */
export function truncLines(s, headLines, tailLines) {
  if (typeof s !== "string") return s;
  const lines = s.split("\n");
  if (lines.length <= headLines + tailLines) return s;
  const removed = lines.length - (headLines + tailLines);
  return [
    ...lines.slice(0, headLines),
    `...[+${removed} lines]...`,
    ...lines.slice(-tailLines),
  ].join("\n");
}

/**
 * Truncate every string value in tool_use.input. Preserve key signal
 * fields (file_path, command, etc.) at full fidelity. Recurse into
 * nested objects/arrays.
 * @param {unknown} input
 * @param {import("./types.mjs").TruncatePolicy} policy
 */
export function truncArgs(input, policy) {
  if (policy.keep_full_args) return input;
  return walk(input, policy, /*depth*/ 0);
}

function walk(v, policy, depth) {
  if (depth > 6) return v;
  if (v == null) return v;
  if (typeof v === "string") return truncStr(v, policy.args_head, policy.args_tail);
  if (Array.isArray(v)) return v.map((x) => walk(x, policy, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (NEVER_TRUNCATE_ARG_KEYS.has(k) && typeof val === "string") {
        out[k] = val;
      } else {
        out[k] = walk(val, policy, depth + 1);
      }
    }
    return out;
  }
  return v;
}

/**
 * Special-case Edit / Write tool args — strip large code bodies.
 * Returns a compact projection of the edit.
 * @param {string} tool   — tool name
 * @param {Record<string, unknown>} input
 * @param {import("./types.mjs").TruncatePolicy} policy
 * @returns {{path?: string, kind: "edit"|"write"|"multi-edit", lines_changed?: number, head?: string, tail?: string, raw_args?: Record<string,unknown>} | undefined}
 */
export function projectEdit(tool, input, policy) {
  if (tool === "Edit") {
    const oldS = String(input.old_string ?? "");
    const newS = String(input.new_string ?? "");
    const oldLines = oldS.split("\n").length;
    const newLines = newS.split("\n").length;
    const combinedDiff = `--- old (${oldLines} lines)\n${truncLines(oldS, policy.edit_head, policy.edit_tail)}\n--- new (${newLines} lines)\n${truncLines(newS, policy.edit_head, policy.edit_tail)}`;
    return {
      path: String(input.file_path ?? ""),
      kind: "edit",
      lines_changed: Math.max(oldLines, newLines),
      head: combinedDiff,
    };
  }
  if (tool === "Write") {
    const body = String(input.content ?? "");
    const lines = body.split("\n").length;
    return {
      path: String(input.file_path ?? ""),
      kind: "write",
      lines_changed: lines,
      head: truncLines(body, policy.edit_head, policy.edit_tail),
    };
  }
  if (tool === "NotebookEdit" || tool === "MultiEdit") {
    return {
      path: String(input.file_path ?? input.notebook_path ?? ""),
      kind: "multi-edit",
      raw_args: truncArgs(input, policy),
    };
  }
  return undefined;
}

/**
 * Truncate tool_result content. Content can be string OR array of blocks.
 * @param {unknown} content
 * @param {import("./types.mjs").TruncatePolicy} policy
 */
export function truncResult(content, policy) {
  if (policy.keep_full_result) {
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  if (typeof content === "string") {
    return truncStr(content, policy.result_head, policy.result_tail);
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => (typeof b === "string" ? b : b?.text ?? b?.content ?? JSON.stringify(b)))
      .join("\n");
    return truncStr(texts, policy.result_head, policy.result_tail);
  }
  return truncStr(JSON.stringify(content ?? null), policy.result_head, policy.result_tail);
}
