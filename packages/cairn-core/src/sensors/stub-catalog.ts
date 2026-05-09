/**
 * Layer A — mechanical stub-pattern catalog.
 *
 * Run regex patterns from `.cairn/config/stub-patterns.yaml` against every
 * file changed in the diff. Hard-severity match fails the run; soft-severity
 * contributes to attestation cross-check (stubs_introduced count).
 *
 * Per PRIMER §10 Layer A. Catalog grows additively via /oops dialog (L25).
 */

import { lineOf } from "@isaacriehm/cairn-state";
import type {
  DiffEntry,
  SensorFinding,
  SensorLanguage,
  SensorResult,
  StubCatalog,
} from "./types.js";

const SENSOR_ID = "stub-pattern-catalog";

/** Detect language from extension. Returns undefined for binaries / unknown. */
export function detectLanguage(path: string): SensorLanguage | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".cts") || lower.endsWith(".mts"))
    return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".cjs") || lower.endsWith(".mjs"))
    return "javascript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".sql")) return "sql";
  return undefined;
}

/** A single stub-pattern regex match found inside the diff. */
export interface StubMatch {
  sensor_id: string;
  pattern_id: string;
  description: string;
  severity: "hard" | "soft";
  path: string;
  line: number;
  matched_text: string;
}

/**
 * Walk the diff and emit a match for every regex hit on lines that were
 * added or are part of a new file. Modified files: only count hits on lines
 * not present at the SHA pin (i.e. genuinely-new debt).
 */
export function detectStubMatches(args: {
  diff: DiffEntry[];
  catalog: StubCatalog;
  /** Filter patterns to these languages. `undefined` = all languages. */
  languages: readonly SensorLanguage[] | undefined;
}): StubMatch[] {
  const out: StubMatch[] = [];
  for (const entry of args.diff) {
    if (entry.status === "deleted") continue;
    const lang = detectLanguage(entry.path);
    if (lang === undefined) continue;
    if (args.languages !== undefined && !args.languages.includes(lang)) continue;
    const after = entry.afterContent ?? "";
    if (after.length === 0) continue;
    const beforeLines = new Set(
      (entry.beforeContent ?? "").split(/\r?\n/),
    );
    const afterLines = after.split(/\r?\n/);
    for (const pattern of args.catalog.patterns) {
      if (!pattern.languages.includes(lang)) continue;
      const re = new RegExp(pattern.regex, "gm");
      let m: RegExpExecArray | null;
      while ((m = re.exec(after)) !== null) {
        const matchedText = m[0];
        // Find the line number this match starts on (1-based).
        const lineIdx = lineOf(after, m.index);
        const lineText = afterLines[lineIdx - 1] ?? "";
        // Only count if this line was added — i.e. not present in the
        // pre-change content. Catches genuinely-new debt; ignores stubs that
        // existed prior. For added files the beforeLines set is empty.
        if (beforeLines.has(lineText)) continue;
        out.push({
          sensor_id: SENSOR_ID,
          pattern_id: pattern.id,
          description: pattern.description,
          severity: pattern.severity,
          path: entry.path,
          line: lineIdx,
          matched_text: matchedText,
        });
        if (re.lastIndex === m.index) re.lastIndex += 1;
      }
    }
  }
  return out;
}

/** Convert a character offset within `text` to a 1-based line number. */


/** Run the Layer A sensor against a diff. */
export function runStubCatalog(args: {
  diff: DiffEntry[];
  catalog: StubCatalog;
  languages: readonly SensorLanguage[];
}): SensorResult {
  const startedAt = Date.now();
  const matches = detectStubMatches({
    diff: args.diff,
    catalog: args.catalog,
    languages: args.languages,
  });
  const findings: SensorFinding[] = matches.map((m) => ({
    sensor_id: SENSOR_ID,
    pattern_id: m.pattern_id,
    path: m.path,
    line: m.line,
    matched_text: m.matched_text,
    severity: m.severity,
    message: `${m.path}:${m.line} matches stub pattern \`${m.pattern_id}\` — ${m.description}`,
  }));
  const ok = findings.every((f) => f.severity !== "hard");
  return {
    sensor_id: SENSOR_ID,
    ok,
    duration_ms: Date.now() - startedAt,
    findings,
  };
}
