/**
 * Mutate the `<slug>:` extension block inside `.harness/config/workflow.md`.
 *
 * The init mapper proposes per-project globs that have to land in TWO places:
 *   1. `.harness/config.yaml` — the project overlay (built by `init.ts` directly)
 *   2. `.harness/config/workflow.md` — the `<slug>:` block in YAML frontmatter
 *
 * (2) is shipped as a template with placeholder values (pilot_module: ALL,
 * empty arrays). After seed substitutes `<project_name>:` → `<slug>:`, this
 * module patches the slug block with the mapper's outputs while preserving
 * the rest of the frontmatter (comments, key order, sibling keys) and the
 * markdown body below the closing `---`.
 *
 * Round-trip uses `yaml`'s `parseDocument` API so comments outside the slug
 * block survive. Comments inside the slug block are dropped on the keys we
 * mutate; that's acceptable because the placeholder block is comment-light.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  isMap,
  isSeq,
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq,
  type Document,
  type Node,
} from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export interface WorkflowSlugBlockUpdate {
  pilot_module?: string;
  route_handler_globs?: string[];
  dto_globs?: string[];
  generator_source_globs?: string[];
  high_stakes_globs?: string[];
  off_limits_append?: string[];
}

export interface UpdateResult {
  applied_keys: string[];
  off_limits_added: string[];
}

export function updateWorkflowSlugBlock(args: {
  workflowMdPath: string;
  slug: string;
  update: WorkflowSlugBlockUpdate;
}): UpdateResult {
  const text = readFileSync(args.workflowMdPath, "utf8");
  const fmMatch = FRONTMATTER_RE.exec(text);
  if (fmMatch === null || fmMatch[1] === undefined) {
    throw new Error(
      `workflow.md missing YAML frontmatter at ${args.workflowMdPath}`,
    );
  }
  const frontmatter = fmMatch[1];
  const body = text.slice(fmMatch[0].length);
  const doc = parseDocument(frontmatter);
  const docRoot = doc.contents;
  if (!isMap(docRoot)) {
    throw new Error(
      `workflow.md frontmatter is not a YAML map at ${args.workflowMdPath}`,
    );
  }
  // Drop the ParsedNode narrowing; the rest of this fn writes plain values.
  const rootMap = docRoot as YAMLMap;

  const existingBlock = rootMap.get(args.slug, true);
  let slugBlock: YAMLMap;
  if (isMap(existingBlock)) {
    slugBlock = existingBlock as YAMLMap;
  } else {
    slugBlock = new YAMLMap();
    rootMap.set(args.slug, slugBlock);
  }

  const applied: string[] = [];
  const u = args.update;
  if (u.pilot_module !== undefined) {
    slugBlock.set("pilot_module", u.pilot_module);
    applied.push("pilot_module");
  }
  if (u.route_handler_globs !== undefined) {
    slugBlock.set(
      "route_handler_globs",
      doc.createNode(u.route_handler_globs) as Node,
    );
    applied.push("route_handler_globs");
  }
  if (u.dto_globs !== undefined) {
    slugBlock.set("dto_globs", doc.createNode(u.dto_globs) as Node);
    applied.push("dto_globs");
  }
  if (u.generator_source_globs !== undefined) {
    slugBlock.set(
      "generator_source_globs",
      doc.createNode(u.generator_source_globs) as Node,
    );
    applied.push("generator_source_globs");
  }
  if (u.high_stakes_globs !== undefined) {
    slugBlock.set(
      "high_stakes_globs",
      doc.createNode(u.high_stakes_globs) as Node,
    );
    applied.push("high_stakes_globs");
  }

  const offLimitsAdded: string[] = [];
  if (u.off_limits_append !== undefined && u.off_limits_append.length > 0) {
    const existingOffLimits = slugBlock.get("off_limits", true);
    let seq: YAMLSeq;
    if (isSeq(existingOffLimits)) {
      seq = existingOffLimits as YAMLSeq;
    } else {
      seq = new YAMLSeq();
      slugBlock.set("off_limits", seq);
    }
    const existingValues = new Set<string>();
    for (const item of seq.items) {
      const value = scalarValue(item);
      if (typeof value === "string") existingValues.add(value);
    }
    for (const candidate of u.off_limits_append) {
      if (!existingValues.has(candidate)) {
        seq.add(candidate);
        existingValues.add(candidate);
        offLimitsAdded.push(candidate);
      }
    }
    if (offLimitsAdded.length > 0) applied.push("off_limits");
  }

  const out = `---\n${stringifyDoc(doc)}---${body}`;
  writeFileSync(args.workflowMdPath, out, "utf8");
  return { applied_keys: applied, off_limits_added: offLimitsAdded };
}

function scalarValue(item: unknown): unknown {
  if (item instanceof Scalar) return item.value;
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
    return item;
  }
  return undefined;
}

function stringifyDoc(doc: Document.Parsed | Document): string {
  const out = doc.toString({ lineWidth: 0 });
  return out.endsWith("\n") ? out : `${out}\n`;
}
