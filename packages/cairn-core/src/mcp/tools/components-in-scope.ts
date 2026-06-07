import type { McpContext } from "../context.js";
import { componentsInScope } from "@isaacriehm/cairn-state";
import { componentsInScopeInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  path_globs: string[];
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const scope = componentsInScope(ctx.repoRoot, input.path_globs);
  return {
    workspaces: scope.workspaces,
    off_limits: scope.offLimits,
    components: scope.components,
    count: scope.components.length,
  };
}

export const componentsInScopeTool: ToolDef<Input> = {
  name: "cairn_components_in_scope",
  description:
    "List the component-registry inventory the given path_globs are entitled to USE. Resolves the owning workspace(s) by longest-prefix match against component dirs and returns those components plus any [shared]-workspace components; isolated workspaces are named in off_limits (awareness, not usable). Single-app projects return the whole inventory. Read this complete inventory before any UI work, then follow USE > EXTEND > CREATE.",
  inputSchema: componentsInScopeInput,
  handler,
};
