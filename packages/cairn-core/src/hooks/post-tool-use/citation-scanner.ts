/**
 * Scans the visible body of a Read tool's content for cairn citation
 * patterns: §INV invariants and §DEC decisions. Both `§INV-<hash>` and
 * `§DEC-<hash>` are the canonical bare-symbol citation forms produced by the
 * strip-replace phase and resolved by the read-enricher into the legend.
 *
 * (`TODO(TSK-…)` source markers used to be a third pattern, but nothing ever
 * emitted them once the Phase-12 strip stub was removed, so the dead reader was
 * cut — task↔source links can return later as a `MarkerProjection` output.)
 *
 * Per READ_ENRICHER_SPEC §3 — line numbers in the legend should reflect
 * the original source line, so when content is `cat -n`-prefixed
 * (`<num>\t<line>`), strip the prefix for matching but use the prefix
 * number as the reported line. The body text itself is NEVER mutated.
 */

export interface CitationMatch {
  /** Citation id, e.g. "INV-2323232" or "DEC-a3f7b2c". */
  id: string;
  /** 1-indexed line number from cat -n prefix, or iteration index. */
  line: number;
}

export interface ScannedCitations {
  invariants: CitationMatch[];
  /** §DEC-<hash> citations resolved against the decisions ledger. */
  decisions: CitationMatch[];
}

const INVARIANT_RE = /§INV-([0-9a-f]{7,})/g;
// Require `§` prefix so plain `DEC-<hash>` strings (URL fragments, prose
// citations in markdown bodies, GitHub-style refs) don't false-match.
// The strip-replace phase ALWAYS emits the `§` prefix on accepted
// decision tokens (per LENS_SPEC + CLAUDE.md "bare symbols only").
const DEC_RE = /§DEC-([0-9a-f]{7,})/g;
const CAT_N_PREFIX_RE = /^(\d+)\t/;

export function scanCitations(content: string): ScannedCitations {
  const invariants: CitationMatch[] = [];
  const decisions: CitationMatch[] = [];

  if (content.length === 0) {
    return { invariants, decisions };
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
      invariants.push({ id: `INV-${digits}`, line: lineNumber });
    }
    for (const m of lineText.matchAll(DEC_RE)) {
      const digits = m[1];
      if (digits === undefined) continue;
      decisions.push({ id: `DEC-${digits}`, line: lineNumber });
    }
  }

  return { invariants, decisions };
}
