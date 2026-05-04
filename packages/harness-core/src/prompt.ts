import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal Liquid-style template renderer. Supports:
 *   {{var}}                       — substitute scalar value
 *   {{#each LIST}}...{{/each}}    — repeat block per item; inside the block
 *                                   {{this}} resolves to the current item;
 *                                   for object items, {{this.field}} works.
 *
 * Anything not matched is left literal. No conditionals, no nested blocks
 * beyond {{#each}}. The harness's prompt template (`templates/.harness/
 * config/workflow.md`) was authored to fit this surface.
 */

export type TemplateContext = Record<
  string,
  string | number | boolean | string[] | Record<string, string>[] | undefined
>;

export function renderTemplate(template: string, ctx: TemplateContext): string {
  // 1. Each blocks first — they are coarser than scalar substitutions.
  const eachBlockRe = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
  let out = template.replace(eachBlockRe, (_, key: string, body: string) => {
    const list = ctx[key];
    if (!Array.isArray(list)) return "";
    return list
      .map((item) => {
        if (typeof item === "string") {
          return body.replace(/\{\{this\}\}/g, item);
        }
        if (typeof item === "object" && item !== null) {
          let chunk = body.replace(/\{\{this\}\}/g, JSON.stringify(item));
          chunk = chunk.replace(/\{\{this\.(\w+)\}\}/g, (_m, field: string) => {
            const v = (item as Record<string, string>)[field];
            return v === undefined ? "" : String(v);
          });
          return chunk;
        }
        return "";
      })
      .join("");
  });

  // 2. Scalar substitutions.
  out = out.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const v = ctx[key];
    if (v === undefined) return "";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  });

  return out;
}

/**
 * Read the workflow.md template from `<repoRoot>/.harness/config/workflow.md`,
 * strip the YAML frontmatter, and return only the prompt body (everything
 * after the second `---`).
 */
export function loadWorkflowTemplate(repoRoot: string): string {
  const path = join(repoRoot, ".harness", "config", "workflow.md");
  const raw = readFileSync(path, "utf8");
  // Frontmatter ends at the second `---` line.
  const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? (match[1] ?? "") : raw;
}
