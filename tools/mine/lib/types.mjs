// Claude Code session JSONL — schema reference for tools/mine.
//
// Each line is a JSON event. Top-level `type` field discriminates.
// Schema documented by sampling real sessions on 2026-05-12 against
// Claude Code v2.1.139.
//
// === Top-level event types ===
//
// "user"                  — operator prompt OR tool_result wrapper
// "assistant"             — assistant message (text/thinking/tool_use blocks)
// "system"                — hook + duration events (subtype discriminator)
// "attachment"            — file attachment metadata
// "file-history-snapshot" — internal file state tracking (SKIP)
// "ai-title"              — session title
// "last-prompt"           — last-prompt marker
// "permission-mode"       — permission-mode change
//
// === Shared fields (most events) ===
//
// sessionId, uuid, parentUuid, timestamp (ISO), cwd, gitBranch,
// version (CC version), userType, entrypoint, isSidechain, isMeta
//
// === Message events (user / assistant) ===
//
// message: {
//   role: "user" | "assistant",
//   content: string | ContentBlock[],
//   usage?: TokenUsage   // assistant only
// }
// promptId  — user only
// requestId — assistant only
//
// ContentBlock kinds:
//   assistant: text | thinking | tool_use
//   user:      text | tool_result
//
// tool_use:    { type, id, name, input: Record<string,unknown> }
// tool_result: { type, tool_use_id, content: string | array, is_error?: boolean }
// thinking:    { type, thinking: string, signature?: string }
//
// TokenUsage: {
//   input_tokens, output_tokens,
//   cache_creation_input_tokens, cache_read_input_tokens,
//   service_tier, server_tool_use, cache_creation, iterations, speed
// }
//
// === System events ===
//
// subtype: "stop_hook_summary" | "turn_duration" | string
//   stop_hook_summary: hookCount, hookErrors[], hookInfos[], hasOutput,
//                      stopReason, preventedContinuation, toolUseID, level
//   turn_duration:     durationMs, messageCount

/**
 * Projected event kind discriminator (after lib/project.mjs).
 * @typedef {"user_text"|"assistant_text"|"thinking"|"tool_use"|"tool_result"|"system"|"attachment"|"permission"|"title"|"last_prompt"|"snapshot"} ProjectedKind
 */

/**
 * Projected event — noise-stripped, truncated.
 * @typedef {object} ProjectedEvent
 * @property {string} session_id
 * @property {string} [uuid]
 * @property {string|null} [parent_uuid]
 * @property {string} [ts]
 * @property {ProjectedKind} kind
 * @property {string} [tool]
 * @property {string} [tool_use_id]
 * @property {boolean} [is_error]
 * @property {"ok"|"error"} [status]
 * @property {string} [text]
 * @property {Record<string,unknown>} [args]
 * @property {string} [result_text]
 * @property {number} [tok_in]
 * @property {number} [tok_out]
 * @property {number} [cache_read]
 * @property {number} [cache_create]
 * @property {string} [cwd]
 * @property {string} [git_branch]
 * @property {string} [cc_version]
 * @property {number} [dur_ms]
 * @property {number} [hook_count]
 * @property {string[]} [hook_errors]
 * @property {string} [subtype]
 * @property {Record<string,unknown>} [edit]
 */

/**
 * Truncation policy — defaults sized for AI context budget.
 * @typedef {object} TruncatePolicy
 * @property {number} text_head   — head chars kept for free text (default 400)
 * @property {number} text_tail   — tail chars kept for free text (default 200)
 * @property {number} args_head   — head chars for tool args strings (default 300)
 * @property {number} args_tail   — tail chars for tool args strings (default 100)
 * @property {number} result_head — head chars for tool_result (default 200)
 * @property {number} result_tail — tail chars for tool_result (default 200)
 * @property {number} edit_head   — head lines for Edit/Write diffs (default 10)
 * @property {number} edit_tail   — tail lines for Edit/Write diffs (default 5)
 * @property {boolean} keep_full_text   — disable text truncation
 * @property {boolean} keep_full_args   — disable args truncation
 * @property {boolean} keep_full_result — disable result truncation
 */

export const DEFAULT_TRUNCATE = Object.freeze({
  text_head: 400,
  text_tail: 200,
  args_head: 300,
  args_tail: 100,
  result_head: 200,
  result_tail: 200,
  edit_head: 10,
  edit_tail: 5,
  keep_full_text: false,
  keep_full_args: false,
  keep_full_result: false,
});

// Fields in tool_use.input that NEVER truncate (key signal).
export const NEVER_TRUNCATE_ARG_KEYS = new Set([
  "file_path",
  "path",
  "filePath",
  "command",
  "url",
  "tool_name",
  "skill",
  "subagent_type",
  "query",
]);
