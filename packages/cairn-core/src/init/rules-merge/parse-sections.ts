/**
 * Markdown section splitter for rules-merge.
 *
 * Splits a markdown body into H2/H3-headed sections. Each section keeps the
 * original heading line + body until the next heading at the same or lower
 * level. Front-matter (everything before the first heading) is returned as a
 * synthetic section with `level: 0` and `title: ""`.
 *
 * Operator-preserved blocks (between `<!-- harness:keep-start -->` and
 * `<!-- harness:keep-end -->`) are tagged so the classifier can skip them.
 */

import { extractKeepBlocks } from "./keep-markers.js";

export interface RuleSection {
  /** 0 = preamble, 2 = H2, 3 = H3 (we ignore deeper levels — too granular). */
  level: 0 | 2 | 3;
  /** Heading text without leading hashes. Empty for the preamble. */
  title: string;
  /** Body markdown including the heading line itself. */
  body: string;
  /** Byte offset of section start in the original file. */
  startOffset: number;
  /** True when section overlaps a keep-block. */
  protectedByKeepMarker: boolean;
}

export function parseRuleSections(source: string): RuleSection[] {
  const keepBlocks = extractKeepBlocks(source);
  const sections: RuleSection[] = [];
  const lines = source.split("\n");
  let cursor = 0;

  let i = 0;
  let currentStart = 0;
  let currentLevel: 0 | 2 | 3 = 0;
  let currentTitle = "";
  let buffer: string[] = [];

  const flush = (endCursor: number): void => {
    if (buffer.length === 0 && currentLevel === 0) return;
    const body = buffer.join("\n");
    if (body.trim().length === 0) return;
    sections.push({
      level: currentLevel,
      title: currentTitle,
      body,
      startOffset: currentStart,
      protectedByKeepMarker: rangeOverlapsKeep(currentStart, endCursor, keepBlocks),
    });
  };

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineLen = line.length + 1; // +1 for trailing \n
    const heading = parseHeading(line);
    if (heading !== null && (heading.level === 2 || heading.level === 3)) {
      flush(cursor);
      currentStart = cursor;
      currentLevel = heading.level;
      currentTitle = heading.title;
      buffer = [line];
    } else {
      buffer.push(line);
    }
    cursor += lineLen;
  }
  flush(cursor);
  return sections;
}

function parseHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!match) return null;
  const hashes = match[1] ?? "";
  const title = match[2] ?? "";
  return { level: hashes.length as 1 | 2 | 3 | 4 | 5 | 6, title };
}

function rangeOverlapsKeep(
  startOffset: number,
  endOffset: number,
  keepBlocks: { startOffset: number; endOffset: number }[],
): boolean {
  for (const k of keepBlocks) {
    if (startOffset < k.endOffset && endOffset > k.startOffset) return true;
  }
  return false;
}
