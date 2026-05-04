import type { ZodTypeAny } from "zod";
import type { McpContext } from "../context.js";

export type ToolInputShape = Record<string, ZodTypeAny>;

export interface ToolDef<Input> {
  name: string;
  description: string;
  inputSchema: ToolInputShape;
  handler: (ctx: McpContext, input: Input) => Promise<unknown>;
}
