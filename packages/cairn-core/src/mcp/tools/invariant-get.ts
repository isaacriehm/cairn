import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { invariantsDir, parseFrontmatter } from "@isaacriehm/cairn-state";
import { InvariantFrontmatter } from "@isaacriehm/cairn-state";
import { mcpError } from "../errors.js";
import { invariantGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  // Friendly redirect when caller passes a DEC- id by mistake. The schema
  // accepts any <PREFIX>-<hash> shape; this handler validates INV-.
  if (input.id.startsWith("DEC-")) {
    return mcpError(
      "WRONG_TOOL_FOR_KIND",
      `${input.id} is a decision id — call \`cairn_decision_get({id: "${input.id}"})\` instead.`,
    );
  }
  if (!input.id.startsWith("INV-")) {
    return mcpError(
      "VALIDATION_FAILED",
      `id ${input.id} is not an invariant id — invariants look like INV-<7-hex>.`,
    );
  }
  const dir = invariantsDir(ctx.repoRoot);
  if (!existsSync(dir)) {
    return mcpError("INVARIANT_NOT_FOUND", `No invariants directory`);
  }
  // Search both the active layer and the `_inbox/` drafts (resync re-curation
  // writes `<id>.draft.md` there). Mirrors `cairn_decision_get` so the
  // cairn-attention skill resolves a pending INV draft over the MCP surface
  // instead of falling back to a raw file Read. `.draft.md` ends in `.md`, so
  // the same filter catches it; the returned `status: draft` tells the caller
  // which layer it came from.
  const searchDirs = [dir, join(dir, "_inbox")].filter((d) => existsSync(d));
  for (const searchDir of searchDirs) {
    for (const entry of readdirSync(searchDir, { withFileTypes: true, encoding: "utf8" })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const parsed = parseFrontmatter(readFileSync(join(searchDir, entry.name), "utf8"));
      const fm = InvariantFrontmatter.safeParse(parsed.frontmatter);
      if (!fm.success) continue;
      if (fm.data.id !== input.id) continue;
      return {
        id: fm.data.id,
        title: fm.data.title,
        status: fm.data.status ?? "active",
        ...(fm.data.source_run !== undefined ? { source_run: fm.data.source_run } : {}),
        ...(fm.data.source_decision !== undefined
          ? { source_decision: fm.data.source_decision }
          : {}),
        ...(fm.data.introduced_for_bug !== undefined
          ? { introduced_for_bug: fm.data.introduced_for_bug }
          : {}),
        ...(fm.data.sensor !== undefined ? { sensor: fm.data.sensor } : {}),
        ...(fm.data.e2e !== undefined ? { e2e: fm.data.e2e } : {}),
        ...(fm.data.naming_convention !== undefined
          ? { naming_convention: fm.data.naming_convention }
          : {}),
        ...(fm.data.superseded_by !== undefined ? { superseded_by: fm.data.superseded_by } : {}),
        body_markdown: parsed.body,
      };
    }
  }
  return mcpError("INVARIANT_NOT_FOUND", `No invariant with id ${input.id}`);
}

export const invariantGetTool: ToolDef<Input> = {
  name: "cairn_invariant_get",
  description: "Returns §INV invariant body + linked sensor + linked e2e by id.",
  inputSchema: invariantGetInput,
  handler,
};
