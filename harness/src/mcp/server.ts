import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "../logger.js";
import { VERSION } from "../index.js";
import type { McpContext } from "./context.js";
import { isMcpError, mcpError } from "./errors.js";
import { asMcpResult } from "./result.js";
import { recordCall } from "./telemetry.js";
import { allTools } from "./tools/index.js";

const log = logger("mcp.server");

export interface StartServerOptions {
  ctx: McpContext;
  /** When true, do not connect to stdio — caller wires its own transport. */
  noConnect?: boolean;
}

export async function startMcpServer(opts: StartServerOptions): Promise<{
  server: McpServer;
  close: () => Promise<void>;
}> {
  const { ctx } = opts;
  const server = new McpServer({ name: "harness-mcp", version: VERSION });

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (rawInput) => {
        const start = process.hrtime.bigint();
        let payload: unknown;
        try {
          payload = await tool.handler(ctx, rawInput as never);
        } catch (err) {
          payload = mcpError(
            "OPERATION_TIMEOUT",
            err instanceof Error ? err.message : "tool handler threw",
          );
          log.error({ tool: tool.name, err: String(err) }, "tool handler threw");
        }
        const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        const result = asMcpResult(payload);
        const resultSize =
          result.content?.[0]?.type === "text" ? result.content[0].text.length : 0;
        try {
          recordCall(ctx, {
            ts: new Date().toISOString(),
            tool: tool.name,
            args: rawInput ?? {},
            result_kind: isMcpError(payload) ? "error" : "ok",
            result_size: resultSize,
            duration_ms: Math.round(durationMs * 100) / 100,
          });
        } catch {
          // telemetry must not break tool calls
        }
        return result;
      },
    );
  }

  if (opts.noConnect !== true) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info({ tools: allTools.length, repoRoot: ctx.repoRoot }, "MCP server listening on stdio");
  }

  return {
    server,
    close: async () => {
      await server.close();
    },
  };
}
