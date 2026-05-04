/**
 * Phase 7c — operator keep-section preservation.
 *
 * After adoption, harness regenerates CLAUDE.md / AGENTS.md from ground state
 * on each sweep. Operator-written sections survive only when wrapped in a pair
 * of HTML comment markers:
 *
 *     <!-- harness:keep-start -->
 *     ... operator content (preserved verbatim) ...
 *     <!-- harness:keep-end -->
 *
 * These helpers parse + render those blocks.
 */

export const KEEP_START_MARKER = "<!-- harness:keep-start -->";
export const KEEP_END_MARKER = "<!-- harness:keep-end -->";

export interface KeepBlock {
  /** Optional operator label after the start marker (e.g. `:custom-flow`). */
  label: string;
  /** Body between the markers (markers excluded). */
  body: string;
  /** Byte offset in the source file where the block starts. */
  startOffset: number;
  /** Byte offset where the block (incl. closing marker) ends. */
  endOffset: number;
}

const START_RE = /<!--\s*harness:keep-start(?::([^\s]+))?\s*-->/g;
const END_TOKEN = "<!-- harness:keep-end -->";

export function extractKeepBlocks(source: string): KeepBlock[] {
  const blocks: KeepBlock[] = [];
  let match: RegExpExecArray | null;
  START_RE.lastIndex = 0;
  while ((match = START_RE.exec(source)) !== null) {
    const startOffset = match.index;
    const afterStart = match.index + match[0].length;
    // Find a matching end. We look for the literal token to keep parsing tight.
    const endIdx = source.indexOf(END_TOKEN, afterStart);
    if (endIdx === -1) break;
    const endOffset = endIdx + END_TOKEN.length;
    let body = source.slice(afterStart, endIdx);
    body = body.replace(/^\n/, "").replace(/\n$/, "");
    blocks.push({
      label: match[1] ?? "",
      body,
      startOffset,
      endOffset,
    });
    START_RE.lastIndex = endOffset;
  }
  return blocks;
}

/**
 * Wraps `body` with the keep markers. Adds an optional label.
 */
export function renderKeepBlock(body: string, label?: string): string {
  const labelPart = label && label.length > 0 ? `:${label}` : "";
  return [
    `<!-- harness:keep-start${labelPart} -->`,
    body,
    KEEP_END_MARKER,
  ].join("\n");
}

/**
 * Replace any harness-rendered region of `existing` with `regenerated`, while
 * preserving every keep-block from `existing` at its original logical anchor:
 * the regenerator inserts a placeholder marker `<!-- harness:keep-anchor:N -->`
 * for each keep block; this helper substitutes those anchors back to the real
 * keep blocks. If a keep block has no matching anchor it is appended at the
 * end of the file under a "## Operator-preserved sections" heading.
 */
export function reapplyKeepBlocks(
  regenerated: string,
  keepBlocks: KeepBlock[],
): string {
  if (keepBlocks.length === 0) return regenerated;
  let out = regenerated;
  const consumed = new Set<number>();
  for (let i = 0; i < keepBlocks.length; i++) {
    const block = keepBlocks[i];
    if (block === undefined) continue;
    const anchor = `<!-- harness:keep-anchor:${i} -->`;
    if (out.includes(anchor)) {
      out = out.replace(anchor, renderKeepBlock(block.body, block.label));
      consumed.add(i);
    }
  }
  const orphans = keepBlocks
    .map((b, idx) => ({ b, idx }))
    .filter(({ idx, b }) => !consumed.has(idx) && b !== undefined);
  if (orphans.length === 0) return out;
  const trailer: string[] = [
    "",
    "<!-- harness:appendix-start -->",
    "## Operator-preserved sections",
    "",
  ];
  for (const o of orphans) {
    if (o.b === undefined) continue;
    trailer.push(renderKeepBlock(o.b.body, o.b.label));
    trailer.push("");
  }
  trailer.push("<!-- harness:appendix-end -->");
  trailer.push("");
  return `${out.trimEnd()}\n${trailer.join("\n")}`;
}
