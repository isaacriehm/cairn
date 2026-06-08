/**
 * Layer A — mechanical stub-pattern catalog.
 *
 * Run regex patterns from `.cairn/config/stub-patterns.yaml` against every
 * file changed in the diff. Hard-severity match fails the run; soft-severity
 * contributes to attestation cross-check (stubs_introduced count).
 *
 * Layer A mechanical stub-pattern catalog. Catalog grows additively via /oops dialog.
 */

import { lineOf, matchAnyGlob, sensorLangForFile } from "@isaacriehm/cairn-state";
import type {
  DiffEntry,
  SensorFinding,
  SensorLanguage,
  SensorResult,
  StubCatalog,
} from "./types.js";

const SENSOR_ID = "stub-pattern-catalog";

/**
 * Detect sensor language from extension via the shared `languages.ts` profile
 * table (single source of truth). Returns undefined for binaries / unknown.
 */
export function detectLanguage(path: string): SensorLanguage | undefined {
  return sensorLangForFile(path);
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
      if (
        pattern.skip_globs !== undefined &&
        pattern.skip_globs.length > 0 &&
        matchAnyGlob(entry.path, pattern.skip_globs)
      ) {
        continue;
      }
      const re = new RegExp(pattern.regex, "gm");
      const mustContainRe =
        pattern.must_contain !== undefined
          ? new RegExp(pattern.must_contain, "m")
          : null;
      let m: RegExpExecArray | null;
      while ((m = re.exec(after)) !== null) {
        const matchedText = m[0];
        // must_contain post-filter: the outer regex captured a candidate
        // block; only emit a finding if the inner regex matches inside
        // that block. Lets coarse outer patterns (e.g. "3+ consecutive
        // `//` lines") gate on a code-syntax signal (`;`, `=>`, `const`,
        // `function`, etc.) and skip pure narrative / doc preamble.
        if (mustContainRe !== null && !mustContainRe.test(matchedText)) {
          if (re.lastIndex === m.index) re.lastIndex += 1;
          continue;
        }
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


/** Run the Layer A sensor against a diff. `languages: undefined` = all. */
export function runStubCatalog(args: {
  diff: DiffEntry[];
  catalog: StubCatalog;
  languages: readonly SensorLanguage[] | undefined;
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
