/**
 * Scans the visible body of a Read tool's content for harness citation
 * patterns: §V invariants, TODO(TSK-...) linked todos, and (banned)
 * DEC-id references.
 *
 * Per READ_ENRICHER_SPEC §3 — line numbers in the legend should reflect
 * the original source line, so when content is `cat -n`-prefixed
 * (`<num>\t<line>`), strip the prefix for matching but use the prefix
 * number as the reported line. The body text itself is NEVER mutated.
 */

export interface CitationMatch {
  /** Citation id, e.g. "V0023" or "TSK-auth-refactor" or "DEC-0042". */
  id: string;
  /** 1-indexed line number from cat -n prefix, or iteration index. */
  line: number;
}

export interface ScannedCitations {
  invariants: CitationMatch[];
  todos: CitationMatch[];
  /** Banned DEC-N citations — for the policy-violation legend. */
  decIds: CitationMatch[];
}

const INVARIANT_RE = /§V(\d+)/g;
const TODO_RE = /TODO\(TSK-([^)]+)\)/g;
const DEC_RE = /DEC-(\d+)/g;
const CAT_N_PREFIX_RE = /^(\d+)\t/;

export function scanCitations(content: string): ScannedCitations {
  const invariants: CitationMatch[] = [];
  const todos: CitationMatch[] = [];
  const decIds: CitationMatch[] = [];

  if (content.length === 0) {
    return { invariants, todos, decIds };
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const prefixMatch = raw.match(CAT_N_PREFIX_RE);
    let lineText: string;
    let lineNumber: number;
    if (prefixMatch) {
      const num = Number.parseInt(prefixMatch[1] ?? "", 10);
      lineNumber = Number.isFinite(num) && num > 0 ? num : i + 1;
      lineText = raw.slice(prefixMatch[0].length);
    } else {
      lineNumber = i + 1;
      lineText = raw;
    }

    // Reset lastIndex implicitly via fresh matchAll calls.
    for (const m of lineText.matchAll(INVARIANT_RE)) {
      const digits = m[1];
      if (digits === undefined) continue;
      invariants.push({ id: `V${digits}`, line: lineNumber });
    }
    for (const m of lineText.matchAll(TODO_RE)) {
      const tail = m[1];
      if (tail === undefined) continue;
      todos.push({ id: `TSK-${tail}`, line: lineNumber });
    }
    for (const m of lineText.matchAll(DEC_RE)) {
      const digits = m[1];
      if (digits === undefined) continue;
      decIds.push({ id: `DEC-${digits}`, line: lineNumber });
    }
  }

  return { invariants, todos, decIds };
}
