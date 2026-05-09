import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { McpContext } from "../context.js";
import { groundDir } from "@isaacriehm/cairn-state";
import { mcpError } from "./types.js";
import type { ToolDef } from "./types.js";
import { z } from "zod";

const TopicEntrySchema = z.object({
  topic: z.string(),
  canonical_path: z.string(),
  audience: z.string().optional(),
});

const TopicsFileSchema = z.object({
  version: z.number(),
  topics: z.array(TopicEntrySchema),
});

type TopicEntry = z.infer<typeof TopicEntrySchema>;

const canonicalForTopicInput = {
  topic: z.string(),
};

interface Input {
  topic: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const file = join(groundDir(ctx.repoRoot), "canonical-map", "topics.yaml");
  if (!existsSync(file)) {
    return mcpError(
      "TOPIC_NOT_REGISTERED",
      `Topic "${input.topic}" is not registered. Curated registry only — do NOT invent topics.`,
    );
  }

  let list: TopicEntry[] = [];
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = parseYaml(raw);
    const result = TopicsFileSchema.safeParse(parsed);
    if (result.success) {
      list = result.data.topics;
    }
  } catch {
    /* list = [] */
  }
  const entry = list.find((t) => t.topic === input.topic);
  if (!entry) {
    return mcpError(
      "TOPIC_NOT_REGISTERED",
      `Topic "${input.topic}" is not registered. Curated registry only — do NOT invent topics.`,
    );
  }

  const absPath = join(ctx.repoRoot, entry.canonical_path);
  if (!existsSync(absPath)) {
    return mcpError(
      "CANONICAL_SOURCE_MISSING",
      `Authoritative source for "${input.topic}" missing at ${entry.canonical_path}. Re-run cairn scope rebuild.`,
    );
  }

  const stat = statSync(absPath);
  const body = readFileSync(absPath, "utf8");
  const sha256 = createHash("sha256").update(body).digest("hex");

  return {
    topic: entry.topic,
    canonical_path: entry.canonical_path,
    sha256,
    verified_at: stat.mtime.toISOString(),
    audience: entry.audience ?? "ai-only",
  };
}

export const canonicalForTopicTool: ToolDef<Input> = {
  name: "cairn_canonical_for_topic",
  description:
    "Returns the authoritative canonical_path + sha256 + verified-at for a registered topic. Topics are curated; unknown topics return TOPIC_NOT_REGISTERED.",
  inputSchema: canonicalForTopicInput,
  handler,
};
