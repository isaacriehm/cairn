import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, parseFrontmatter } from "@isaacriehm/cairn-state";
import { DecisionFrontmatter } from "@isaacriehm/cairn-state";
import { mcpError } from "../errors.js";
import { decisionGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  // Friendly redirect when caller passes an INV- id by mistake. The
  // schema accepts any <PREFIX>-<hash> shape; this handler is the place
  // to validate DEC- and route mis-prefixed lookups.
  if (input.id.startsWith("INV-")) {
    return mcpError(
      "WRONG_TOOL_FOR_KIND",
      `${input.id} is an invariant id — call \`cairn_invariant_get({id: "${input.id}"})\` instead.`,
    );
  }
  if (!input.id.startsWith("DEC-")) {
    return mcpError(
      "VALIDATION_FAILED",
      `id ${input.id} is not a decision id — decisions look like DEC-<7-hex>.`,
    );
  }
  const dir = decisionsDir(ctx.repoRoot);
  if (!existsSync(dir)) {
    return mcpError("DECISION_NOT_FOUND", `No decisions directory at ${dir}`);
  }
  // Search both the canonical accepted layer and the `_inbox/` drafts
  // layer. The cairn-attention skill calls this on every pending DEC
  // path; resolving drafts keeps the skill on the MCP surface instead
  // of falling back to `cat` / Read on the raw file.
  const inboxDir = join(dir, "_inbox");
  const searchDirs = [dir, inboxDir].filter((d) => existsSync(d));
  for (const searchDir of searchDirs) {
    const files = readdirSync(searchDir, { withFileTypes: true, encoding: "utf8" });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      const abs = join(searchDir, f.name);
      const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
      const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
      if (!fm.success) continue;
      if (fm.data.id !== input.id) continue;
      return {
        id: fm.data.id,
        title: fm.data.title,
        status: fm.data.status,
        ...(fm.data.scope_globs !== undefined ? { scope_globs: fm.data.scope_globs } : {}),
        ...(fm.data.supersedes !== undefined ? { supersedes: fm.data.supersedes } : {}),
        ...(fm.data.superseded_by !== undefined ? { superseded_by: fm.data.superseded_by } : {}),
        ...(fm.data.decided_at !== undefined ? { decided_at: fm.data.decided_at } : {}),
        ...(fm.data.assertions !== undefined ? { assertions: fm.data.assertions } : {}),
        ...(fm.data.human_review_hint !== undefined
          ? { human_review_hint: fm.data.human_review_hint }
          : {}),
        ...(fm.data.related_invariants !== undefined
          ? { related_invariants: fm.data.related_invariants }
          : {}),
        body_markdown: parsed.body,
      };
    }
  }
  // Suggest near-matches so an AI that hallucinated a sequential id
  // (`DEC-0001`, `DEC-0002`, etc.) can pick the right one on the retry.
  // Real ids are `DEC-<7-hex>` content-addressed.
  const allIds = collectExistingIds(searchDirs);
  return mcpError(
    "DECISION_NOT_FOUND",
    `No decision with id ${input.id}. Real ids are content-addressed (DEC-<7-hex>); sequential placeholders like DEC-0001 don't exist. Try \`cairn_search\` or \`cairn_in_scope\` to find the right id.`,
    allIds.length > 0 ? { available_ids_sample: allIds.slice(0, 10) } : undefined,
  );
}

function collectExistingIds(dirs: string[]): string[] {
  const ids: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d, { withFileTypes: true, encoding: "utf8" })) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        const m = f.name.match(/^(DEC-[0-9a-f]{7,})\.md$/) ?? f.name.match(/^(DEC-[0-9a-f]{7,})\.draft\.md$/);
        if (m && m[1]) ids.push(m[1]);
      }
    } catch {
      // ignore — caller already gated on existsSync
    }
  }
  return ids.sort();
}

export const decisionGetTool: ToolDef<Input> = {
  name: "cairn_decision_get",
  description:
    "Returns full ADR + assertions block for a decision id. **ID format is `DEC-<7-or-more-hex-chars>` (e.g. `DEC-0ae6a8b`), content-addressed — sequential placeholders like `DEC-0001` do not exist; do not invent them.** Resolves both accepted decisions (`.cairn/ground/decisions/<id>.md`) and pending drafts (`_inbox/<id>.draft.md`); the response's `status` field tells the caller which layer the decision came from. Use `cairn_in_scope({path_globs, types: ['decision']})` or `cairn_search(query)` to discover real ids first if you only have a topic.",
  inputSchema: decisionGetInput,
  handler,
};
