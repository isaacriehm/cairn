/**
 * Copy-safety scanner for the PostToolUse Write/Edit guardian.
 *
 * Given a file path and its (post-Write/Edit) content, locate strings
 * that look like internal-only copy leaking into a user-facing surface
 * (TODO/FIXME comments inside JSX text, cairn citations, snake_case
 * identifiers in display strings, internal repo paths, etc.).
 *
 * Implementation is intentionally regex-only — NOT a full AST. For
 * `.tsx`/`.jsx` we extract the contents of string/template literals and
 * the text between `>` and `<`/`{` in JSX. For `.json` we walk values
 * (skipping keys). For `.html`/`.vue`/`.svelte` and any other extension
 * we scan the entire content.
 *
 * Spec: docs/READ_ENRICHER_SPEC.md "Write Guardian" section.
 */

const PATTERNS: ReadonlyArray<{ regex: RegExp; label: string }> = [
  { regex: /\b(TODO|FIXME|HACK|XXX|TEMP|WIP)\b/g, label: "comment-marker" },
  { regex: /§INV-[0-9a-f]{7,}/g, label: "cairn-citation-§INV" },
  { regex: /\bTSK-[a-z0-9-]+\b/g, label: "cairn-citation-TSK" },
  { regex: /\[(PLACEHOLDER|TODO|DRAFT)\]/g, label: "draft-marker" },
  {
    regex: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/g,
    label: "multi-underscore-identifier",
  },
  // Internal path: matches a leading separator (start, whitespace, quote, or
  // backtick) followed by `src/` | `packages/` | `.cairn/`. The whole
  // match is recorded verbatim (including the leading char) so allowlist
  // authoring is consistent — see scanForCopyLeakage callers.
  {
    regex: /(?:^|[\s"'`])(src\/|packages\/|\.cairn\/)/g,
    label: "internal-path",
  },
];

export interface CopyIssue {
  /** 1-indexed line where match occurred. */
  line: number;
  /** Verbatim matched text — used for allowlist comparison. */
  match: string;
  /** Human-readable pattern label, e.g. "comment-marker". */
  pattern: string;
}

interface ScannedRegion {
  /** Text to scan against PATTERNS. */
  text: string;
  /** Absolute index in the original content where this region's `text` begins. */
  baseOffset: number;
}

/**
 * Compute 1-indexed line number of an absolute character index within `content`.
 */
function lineForIndex(content: string, absIndex: number): number {
  let line = 1;
  const cap = Math.min(absIndex, content.length);
  for (let i = 0; i < cap; i++) {
    if (content.charCodeAt(i) === 0x0a) line++;
  }
  return line;
}

function getExt(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  const tail = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const dot = tail.lastIndexOf(".");
  if (dot < 0) return "";
  return tail.slice(dot).toLowerCase();
}

/**
 * For .tsx/.jsx: extract regions worth scanning — the inside of every
 * single-quote, double-quote, and backtick literal, plus JSX text
 * positions. Strict correctness vs. a real parser is not the goal; we
 * accept some false positives (e.g. matches inside non-display strings)
 * — the allowlist is the escape valve.
 */
function jsxRegions(content: string): ScannedRegion[] {
  const regions: ScannedRegion[] = [];

  // Capture string and template literal contents.
  const literalRe = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  for (const m of content.matchAll(literalRe)) {
    const inner = m[2];
    if (typeof inner !== "string" || inner.length === 0) continue;
    if (m.index === undefined) continue;
    // +1 to skip past the opening quote/backtick to where `inner` starts.
    regions.push({ text: inner, baseOffset: m.index + 1 });
  }

  // Capture JSX text positions — `>...<` and `>...{` runs.
  const jsxTextRe = />([^<{]+)</g;
  for (const m of content.matchAll(jsxTextRe)) {
    const inner = m[1];
    if (typeof inner !== "string" || inner.length === 0) continue;
    if (m.index === undefined) continue;
    regions.push({ text: inner, baseOffset: m.index + 1 });
  }

  return regions;
}

/**
 * For .json: walk parsed values (NOT keys). On parse failure, fall back
 * to a regex over `: "..."` value-position strings.
 */
function jsonRegions(content: string): ScannedRegion[] {
  const regions: ScannedRegion[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    parsed = undefined;
  }

  if (parsed !== undefined) {
    const stringValues: string[] = [];
    const visit = (node: unknown): void => {
      if (typeof node === "string") {
        stringValues.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const v of node) visit(v);
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const v of Object.values(node)) visit(v);
      }
    };
    visit(parsed);

    // For each string value, locate its first occurrence as a JSON
    // value-position substring (`"<value>"`) for accurate line numbers.
    for (const sv of stringValues) {
      if (sv.length === 0) continue;
      // Best-effort: search for the literal value enclosed in quotes.
      // Simple identity match — JSON-escape sequences may shift, but
      // the line number derived will still point at the right block in
      // practice. False positives here just produce slightly wrong
      // lines, never wrong matches.
      const escaped = JSON.stringify(sv);
      const idx = content.indexOf(escaped);
      if (idx < 0) continue;
      regions.push({ text: sv, baseOffset: idx + 1 });
    }
    return regions;
  }

  // Fallback: regex over value-position strings.
  const valueRe = /:\s*"((?:\\.|[^"\\])*)"/g;
  for (const m of content.matchAll(valueRe)) {
    const inner = m[1];
    if (typeof inner !== "string" || inner.length === 0) continue;
    if (m.index === undefined) continue;
    // Locate the offset of the captured value's opening quote.
    const matchText = m[0];
    const quoteIdx = matchText.indexOf('"');
    if (quoteIdx < 0) continue;
    regions.push({ text: inner, baseOffset: m.index + quoteIdx + 1 });
  }
  return regions;
}

function scanRegion(
  region: ScannedRegion,
  content: string,
  out: CopyIssue[],
): void {
  for (const { regex, label } of PATTERNS) {
    // Each pattern uses /g; reset lastIndex via fresh matchAll on the slice.
    for (const m of region.text.matchAll(regex)) {
      if (m.index === undefined) continue;
      const matchText = m[0];
      if (matchText.length === 0) continue;
      const absIndex = region.baseOffset + m.index;
      out.push({
        line: lineForIndex(content, absIndex),
        match: matchText,
        pattern: label,
      });
    }
  }
}

export function scanForCopyLeakage(
  content: string,
  filePath: string,
): CopyIssue[] {
  if (content.length === 0) return [];
  const ext = getExt(filePath);
  const issues: CopyIssue[] = [];

  let regions: ScannedRegion[];
  if (ext === ".tsx" || ext === ".jsx") {
    regions = jsxRegions(content);
  } else if (ext === ".json") {
    regions = jsonRegions(content);
  } else {
    // .html, .vue, .svelte, and default fallback — scan everything.
    regions = [{ text: content, baseOffset: 0 }];
  }

  for (const region of regions) {
    scanRegion(region, content, issues);
  }

  return issues;
}
