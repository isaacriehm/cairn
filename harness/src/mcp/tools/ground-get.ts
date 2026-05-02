import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import {
  groundDir,
  manifestPath,
  qualityGradesPath,
} from "../../ground/index.js";
import { mcpError } from "../errors.js";
import { groundGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  category: "schema" | "routes" | "events" | "quality_grades" | "glossary" | "manifest";
  key?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const root = groundDir(ctx.repoRoot);
  switch (input.category) {
    case "manifest": {
      const path = manifestPath(ctx.repoRoot);
      if (!existsSync(path)) {
        return mcpError("FILE_NOT_FOUND", "manifest.yaml not present (daemon not run yet?)");
      }
      return { path: ".harness/ground/manifest.yaml", content: readFileSync(path, "utf8") };
    }
    case "quality_grades": {
      const path = qualityGradesPath(ctx.repoRoot);
      if (!existsSync(path)) {
        return mcpError(
          "FILE_NOT_FOUND",
          "quality-grades.yaml not present (daemon not run yet?)",
        );
      }
      return { path: ".harness/ground/quality-grades.yaml", content: readFileSync(path, "utf8") };
    }
    case "glossary": {
      const path = join(root, "glossary.md");
      if (!existsSync(path)) {
        return mcpError("FILE_NOT_FOUND", "glossary.md not present");
      }
      return { path: ".harness/ground/glossary.md", content: readFileSync(path, "utf8") };
    }
    case "schema":
    case "routes":
    case "events": {
      const dir = join(root, input.category);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        return mcpError(
          "FILE_NOT_FOUND",
          `${input.category}/ extracts not present (no profile extractor for this stack?)`,
        );
      }
      if (input.key !== undefined) {
        const candidate = join(dir, `${input.key}.md`);
        const fallback = join(dir, `${input.key}.yaml`);
        const target = existsSync(candidate)
          ? candidate
          : existsSync(fallback)
            ? fallback
            : null;
        if (!target) {
          return mcpError(
            "FILE_NOT_FOUND",
            `No ${input.category} entry for key "${input.key}"`,
          );
        }
        return {
          path: `.harness/ground/${input.category}/${input.key}${target.endsWith(".yaml") ? ".yaml" : ".md"}`,
          content: readFileSync(target, "utf8"),
        };
      }
      // No key — return the directory listing.
      return {
        path: `.harness/ground/${input.category}/`,
        listing: readDirShallow(dir),
      };
    }
  }
}

function readDirShallow(dir: string): string[] {
  try {
    return [
      ...new Set(
        require("node:fs")
          .readdirSync(dir, { withFileTypes: true, encoding: "utf8" })
          .filter((d: { isFile: () => boolean }) => d.isFile())
          .map((d: { name: string }) => d.name),
      ),
    ] as string[];
  } catch {
    return [];
  }
}

export const groundGetTool: ToolDef<Input> = {
  name: "harness_ground_get",
  description:
    "Read a generated ground extract. Categories: schema | routes | events | quality_grades | glossary | manifest. `key` narrows within a category (e.g., schema → table name).",
  inputSchema: groundGetInput,
  handler,
};
