import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bodyContentHash,
  extractExportNames,
  isGhost,
  profileForFile,
  registerComponentEntry,
  type ComponentRegistryEntry,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { componentRegisterInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  file: string;
  export_name: string;
  name: string;
  category: string;
  purpose: string;
  aliases: string[];
  workspace?: string;
  singleton?: boolean;
  status?: string;
  uses?: string[];
}

/**
 * Register one component into the out-of-repo headerless registry (§3.8.1).
 * This is the ghost write path that replaces the `@cairn` annotator's source
 * `Edit` — the classification lands in `cairnHome/ground/components/
 * registry.yaml`, keyed (workspace, file, export), and the client source file
 * is never touched. Committed projects register via the in-file header, so the
 * tool refuses there to keep the one-SoT-per-mode rule clean.
 */
async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  if (!isGhost(ctx.repoRoot)) {
    return mcpError(
      "NOT_ALLOWED",
      "cairn_component_register is the ghost-mode write path. Committed projects register a component by its in-file `@cairn <Name>` header (add the header / run the annotator), not via this tool.",
    );
  }
  const abs = join(ctx.repoRoot, input.file);
  if (!existsSync(abs)) {
    return mcpError(
      "FILE_NOT_FOUND",
      `${input.file} does not exist under the repo root — register an existing component file.`,
    );
  }
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `could not read ${input.file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entry: ComponentRegistryEntry = {
    workspace: input.workspace ?? "",
    file: input.file,
    export: input.export_name,
    name: input.name,
    category: input.category,
    purpose: input.purpose,
    aliases: input.aliases,
    uses: input.uses ?? [],
    // v1 fingerprint: whole-file body hash (one component per file is the UI
    // convention, so the file body is the component span). The export-span hash
    // is a later precision refinement.
    anchor: { content_hash: bodyContentHash(source) },
    // Identity snapshot — the freshness gate (§3.8.1) compares the file's
    // future exports/shape against these to tell an internal refactor from a
    // genuine identity change without ever calling the LLM.
    exports: extractExportNames(source, input.file),
    unit_shaped: profileForFile(input.file)?.isUnitShaped(source, input.file) ?? false,
    ...(input.singleton !== undefined ? { singleton: input.singleton } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
  registerComponentEntry(ctx.repoRoot, entry);

  return {
    registered: true,
    workspace: entry.workspace,
    file: entry.file,
    export: entry.export,
    name: entry.name,
  };
}

export const componentRegisterTool: ToolDef<Input> = {
  name: "cairn_component_register",
  description:
    "Ghost mode only. Register a component into the out-of-repo headerless registry so it joins the store WITHOUT writing a `@cairn` header into client source. Pass the file, the export symbol, and the classification (name/category/purpose/aliases). Use this to resolve an `unregistered unit` finding. Committed projects use the in-file header instead and the tool refuses there.",
  inputSchema: componentRegisterInput,
  handler,
};
