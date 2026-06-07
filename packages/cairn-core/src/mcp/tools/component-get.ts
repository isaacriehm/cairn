import type { McpContext } from "../context.js";
import { getComponent } from "@isaacriehm/cairn-state";
import { mcpError } from "../errors.js";
import { componentGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  name: string;
  workspace?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const found = getComponent(ctx.repoRoot, input.name, input.workspace);
  if (found === null) {
    return mcpError(
      "COMPONENT_NOT_FOUND",
      `No component named "${input.name}"${input.workspace ? ` in workspace ${input.workspace}` : ""}. Read the in-scope inventory via cairn_components_in_scope before assuming it must be created.`,
    );
  }
  return {
    ...found.entry,
    // The raw header tags carry @props / @example — read these before
    // importing so props are never guessed.
    props: found.record.tags.props ?? null,
    example: found.record.tags.example ?? null,
    export_name: found.record.exportName,
  };
}

export const componentGetTool: ToolDef<Input> = {
  name: "cairn_component_get",
  description:
    "Return one component's registry entry by name — its file, category, purpose, aliases, singleton flag, @props, and @example. Read @props before importing so props are never guessed. Pass `workspace` to disambiguate in a monorepo.",
  inputSchema: componentGetInput,
  handler,
};
