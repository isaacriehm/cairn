/**
 * Alignment-pending queue writer — used by Layer A (PostToolUse hook,
 * pass-2-still-ambiguous + tier3-ambiguous paths) and SessionStart Drain
 * (SessionStart drain, Haiku-judge-ambiguous path).
 *
 * The cairn-attention skill renders the file with side-by-side prose
 * and an AskUserQuestion four-option pick. The filename is a content
 * fingerprint slug so re-running with the same prose is idempotent.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { CommentBlock } from "../init/source-comments/index.js";
import { alignmentPendingDir } from "./paths.js";
import { topicSlug } from "./slug.js";

export type AlignmentPendingKind = "tier2-ambiguous" | "tier3-ambiguous";

export interface WriteAlignmentPendingArgs {
  repoRoot: string;
  block: CommentBlock;
  kind: AlignmentPendingKind;
  /** Existing entity id (Tier 2 paths only). */
  existingId?: string;
  /** Existing entity body (Tier 2 paths only). */
  existingBody?: string;
  /**
   * Detector tag stamped into frontmatter — distinguishes Layer A
   * (`layer-a-pass2-ambiguous`) from SessionStart Drain (`layer-c-drain-ambiguous`).
   * Defaults to the Layer A detector for back-compat with the existing
   * `tier3-ambiguous` smoke fixtures.
   */
  detector?: string;
}

export function writeAlignmentPending(args: WriteAlignmentPendingArgs): string {
  const { repoRoot, block, kind } = args;
  const detector = args.detector ?? "layer-a-pass2-ambiguous";
  const dir = alignmentPendingDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const slug = topicSlug(block.prose);
  const filename = `${slug}.md`;
  const abs = join(dir, filename);
  if (existsSync(abs)) return `.cairn/ground/alignment-pending/${filename}`;
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    slug,
    kind,
    source_file: block.file,
    source_range: `${block.startLine}-${block.endLine}`,
    start_line: block.startLine,
    end_line: block.endLine,
    start_offset: block.startOffset,
    end_offset: block.endOffset,
    lang: block.lang,
    raw: block.raw,
    detected_at: now,
    detector,
    severity: "soft",
  };
  if (args.existingId !== undefined) fm["existing_id"] = args.existingId;
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml(fm).trimEnd());
  lines.push("---");
  lines.push("");
  lines.push(`# Alignment pending — ${slug} (${kind})`);
  lines.push("");
  lines.push(`## Block (just written at \`${block.file}:${block.startLine}-${block.endLine}\`)`);
  lines.push("");
  lines.push("```");
  lines.push(block.prose.trim());
  lines.push("```");
  lines.push("");
  if (args.existingId !== undefined && args.existingBody !== undefined) {
    lines.push(`## Existing ${args.existingId}`);
    lines.push("");
    lines.push("```");
    lines.push(args.existingBody.trim());
    lines.push("```");
    lines.push("");
  }
  lines.push("## How to resolve");
  lines.push("");
  if (kind === "tier2-ambiguous") {
    lines.push("Pass 2 dedup judge returned ambiguous. cairn-attention will surface");
    lines.push("a side-by-side render with `[a] same` / `[b] different` /");
    lines.push("`[c] augments` / `[d] leave for later` choices via");
    lines.push("`cairn_resolve_attention({ kind: \"alignment_pending\", ... })`.");
  } else {
    lines.push("Pass 2 creation judge could not classify the block as");
    lines.push("decision / constraint / descriptive. cairn-attention will");
    lines.push("surface `[a] decision` / `[b] constraint` / `[c] descriptive` /");
    lines.push("`[d] leave for later` via");
    lines.push("`cairn_resolve_attention({ kind: \"alignment_pending\", ... })`.");
  }
  lines.push("");
  writeFileSync(abs, lines.join("\n"), "utf8");
  return `.cairn/ground/alignment-pending/${filename}`;
}
