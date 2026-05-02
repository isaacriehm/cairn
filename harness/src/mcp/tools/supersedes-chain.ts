import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, parseFrontmatter } from "../../ground/index.js";
import { DecisionFrontmatter } from "../../ground/index.js";
import { mcpError } from "../errors.js";
import { supersedesChainInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  decision_id: string;
}

interface ChainEntry {
  id: string;
  status: string;
  supersedes: string | null;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const dir = decisionsDir(ctx.repoRoot);
  if (!existsSync(dir)) return mcpError("DECISION_NOT_FOUND", `No decisions directory`);
  const all = new Map<string, ChainEntry>();
  for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parsed = parseFrontmatter(readFileSync(join(dir, entry.name), "utf8"));
    const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    all.set(fm.data.id, {
      id: fm.data.id,
      status: fm.data.status,
      supersedes: fm.data.supersedes ?? null,
    });
  }
  if (!all.has(input.decision_id)) {
    return mcpError("DECISION_NOT_FOUND", `Unknown decision id ${input.decision_id}`);
  }
  // Walk back to root, then forward via reverse-supersedes index.
  const reverse = new Map<string, string>(); // supersedes-id → newer-id
  for (const e of all.values()) {
    if (e.supersedes) reverse.set(e.supersedes, e.id);
  }
  // Find root (oldest) by walking supersedes chain backward.
  let root = input.decision_id;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(root)) break;
    seen.add(root);
    const cur = all.get(root);
    if (!cur || cur.supersedes === null) break;
    root = cur.supersedes;
  }
  // Forward chain.
  const chain: ChainEntry[] = [];
  const fwdSeen = new Set<string>();
  let cursor: string | undefined = root;
  while (cursor && !fwdSeen.has(cursor)) {
    fwdSeen.add(cursor);
    const e = all.get(cursor);
    if (!e) break;
    chain.push(e);
    cursor = reverse.get(cursor);
  }
  return chain;
}

export const supersedesChainTool: ToolDef<Input> = {
  name: "harness_supersedes_chain",
  description:
    "Forward chain from earliest superseded decision to current binding decision (status=accepted at the head).",
  inputSchema: supersedesChainInput,
  handler,
};
