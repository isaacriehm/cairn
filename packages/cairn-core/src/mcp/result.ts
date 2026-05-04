import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpErrorPayload } from "./errors.js";
import { isMcpError } from "./errors.js";

/**
 * Wraps a tool's payload (success object OR error envelope) as the MCP
 * CallToolResult shape: { content: [{ type: "text", text: <json> }], isError? }.
 */
export function asMcpResult(payload: unknown): CallToolResult {
  const isError = isMcpError(payload);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

export type { McpErrorPayload };
