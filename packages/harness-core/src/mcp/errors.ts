/**
 * Error envelope per MCP_SURFACE §"Failure modes".
 *
 * Tools NEVER throw. They return either a success payload or an error envelope
 * shaped as { error: { code, message, details? } }. The envelope is wrapped in
 * the MCP `CallToolResult` content text.
 */

export type McpErrorCode =
  | "VALIDATION_FAILED"
  | "TOOL_NOT_FOUND"
  | "PATH_OUTSIDE_REPO"
  | "PATH_HISTORICAL_USE_QUERY_HISTORY"
  | "PATH_NOT_ALLOWED"
  | "FILE_NOT_FOUND"
  | "DAEMON_UNAVAILABLE"
  | "OPERATION_TIMEOUT"
  | "DECISION_NOT_FOUND"
  | "DECISION_ID_TAKEN"
  | "INVALID_ASSERTION_KIND"
  | "SUPERSEDES_NOT_FOUND"
  | "INVARIANT_NOT_FOUND"
  | "TOPIC_NOT_REGISTERED"
  | "RUN_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "NOT_ALLOWED"
  | "NOT_IMPLEMENTED";

export interface McpErrorPayload {
  error: {
    code: McpErrorCode;
    message: string;
    details?: unknown;
  };
}

export function mcpError(
  code: McpErrorCode,
  message: string,
  details?: unknown,
): McpErrorPayload {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

export function isMcpError(payload: unknown): payload is McpErrorPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "object"
  );
}
