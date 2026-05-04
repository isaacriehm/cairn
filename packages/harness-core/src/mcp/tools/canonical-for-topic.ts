import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { McpContext } from "../context.js";
import { groundDir, parseFrontmatter } from "../../ground/index.js";
import { mcpError } from "../errors.js";
import { canonicalForTopicInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  topic: string;
}

interface TopicEntry {
  topic: string;
  canonical_path: string;
  audience?: string;
}

interface TopicsFile {
  version: number;
  topics: TopicEntry[];
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const file = join(groundDir(ctx.repoRoot), "canonical-map", "topics.yaml");
  if (!existsSync(file)) {
    return mcpError(
      "TOPIC_NOT_REGISTERED",
      `No canonical-map registered (topics.yaml not found at ${file})`,
    );
  }
  const parsedFile = parseYaml(readFileSync(file, "utf8")) as TopicsFile | null;
  const list: TopicEntry[] = parsedFile?.topics ?? [];
  const entry = list.find((t) => t.topic === input.topic);
  if (!entry) {
    return mcpError(
      "TOPIC_NOT_REGISTERED",
      `Topic "${input.topic}" is not registered. Curated registry only — do NOT invent topics.`,
      { available: list.map((t) => t.topic) },
    );
  }
  const docPath = join(ctx.repoRoot, entry.canonical_path.split("#")[0] ?? entry.canonical_path);
  if (!existsSync(docPath) || !statSync(docPath).isFile()) {
    return mcpError(
      "FILE_NOT_FOUND",
      `Topic registered, but canonical_path does not exist: ${entry.canonical_path}`,
    );
  }
  const buf = readFileSync(docPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const fm = parseFrontmatter(buf.toString("utf8")).frontmatter;
  return {
    topic: entry.topic,
    canonical_path: entry.canonical_path,
    sha256,
    verified_at: fm?.["verified-at"] ?? null,
    audience: entry.audience ?? fm?.audience ?? null,
  };
}

export const canonicalForTopicTool: ToolDef<Input> = {
  name: "harness_canonical_for_topic",
  description:
    "Returns the authoritative canonical_path + sha256 + verified-at for a registered topic. Topics are curated; unknown topics return TOPIC_NOT_REGISTERED.",
  inputSchema: canonicalForTopicInput,
  handler,
};
