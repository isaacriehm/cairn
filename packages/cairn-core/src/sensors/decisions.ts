/**
 * Decision-assertions sensor.
 *
 * For every accepted decision whose `scope_globs` overlap the diff, evaluate
 * each machine-readable `assertion` against the post-change repository state.
 * Failure quotes the failing assertion id + decision id + the contradicting
 * line.
 *
 * Per L26+L41 — 11 assertion kinds. AST-level precision is v2; this module
 * uses regex-based approximations and surfaces soft findings when it cannot
 * verify with confidence (the reviewer subagent in Phase 10 catches the rest).
 */

import { execSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decisionsDir,
  escapeRegExp,
  knownExtensions,
  lineOf,
  matchAnyGlob,
  parseFrontmatter,
} from "@isaacriehm/cairn-state";
import { DecisionFrontmatter, type DecisionAssertion } from "@isaacriehm/cairn-state";
import type {
  DiffEntry,
  SensorFinding,
  SensorResult,
} from "./types.js";

const SENSOR_ID = "decision-assertions";

/**
 * Languages whose `ast_pattern` we can honestly approximate with a text regex
 * (no ast-grep engine is wired). A DEC targeting any other language is
 * downgraded to a visible advisory rather than reporting an AST verdict it
 * never computed. Accepts both ast-grep ids and bare extensions-as-ids.
 */
const AST_TEXT_APPROX = new Set<string>([
  "typescript",
  "ts",
  "tsx",
  "javascript",
  "js",
  "jsx",
  "python",
  "py",
  "go",
  "rust",
  "rs",
  "ruby",
  "rb",
  "sql",
]);

/**
 * Files that may carry a DB schema or migration — any known code file plus the
 * schema DSLs. Replaces the old `sql|prisma|ts|py|rb` allowlist so schema
 * assertions check Go/Java/Kotlin/C#/PHP migrations too, not just JS/Python/Ruby.
 */
const SCHEMA_FILE_EXTS = new Set<string>([...knownExtensions(), ".prisma", ".graphql", ".gql"]);

function isSchemaFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && SCHEMA_FILE_EXTS.has(path.slice(dot).toLowerCase());
}

/** All decisions accepted at HEAD with parsed frontmatter. */
export function loadAcceptedDecisions(repoRoot: string): DecisionFrontmatter[] {
  const dir = decisionsDir(repoRoot);
  if (!existsSync(dir)) return [];
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const out: DecisionFrontmatter[] = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!d.name.endsWith(".md")) continue;
    if (d.name.startsWith("_")) continue;
    const abs = join(dir, d.name);
    const fm = parseFrontmatter(readFileSync(abs, "utf8")).frontmatter;
    const parsed = DecisionFrontmatter.safeParse(fm);
    if (!parsed.success) continue;
    if (parsed.data.status !== "accepted") continue;
    if (parsed.data.superseded_by) continue;
    out.push(parsed.data);
  }
  return out;
}

/** Decisions whose scope_globs overlap the diff. */
export function decisionsInScope(
  decisions: DecisionFrontmatter[],
  diff: DiffEntry[],
): DecisionFrontmatter[] {
  return decisions.filter((d) => {
    const globs = d.scope_globs ?? [];
    if (globs.length === 0) return true; // no scope = applies everywhere
    return diff.some((entry) => matchAnyGlob(entry.path, globs));
  });
}

/** Read every tracked file in the mirror once, lazy, with a 100-file LRU cap. */
class MirrorFileReader {
  private cache = new Map<string, string>();
  private readonly MAX_FILES = 100;
  constructor(private readonly mirrorPath: string) {}
  read(relPath: string): string {
    const cached = this.cache.get(relPath);
    if (cached !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(relPath);
      this.cache.set(relPath, cached);
      return cached;
    }
    try {
      const text = readFileSync(join(this.mirrorPath, relPath), "utf8");
      if (this.cache.size >= this.MAX_FILES) {
        // Evict oldest (first) entry
        const first = this.cache.keys().next().value;
        if (first !== undefined) this.cache.delete(first);
      }
      this.cache.set(relPath, text);
      return text;
    } catch {
      this.cache.set(relPath, "");
      return "";
    }
  }
}

/**
 * Walk the mirror once and list every tracked file (not gitignored). This is
 * used by assertion kinds that need to scan beyond the diff (e.g. when the
 * assertion targets a file the agent didn't change).
 */
export function listMirrorFiles(mirrorPath: string): string[] {
  // Use git ls-files synchronously for simplicity. simple-git's async API is
  // available too; we keep this synchronous so assertion evaluation remains
  // a tight loop. Plus untracked-but-not-ignored, since the agent's new
  // files won't be tracked yet at sensor time.
  try {
    const tracked = execSync("git ls-files", {
      cwd: mirrorPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: mirrorPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return [...tracked.split("\n"), ...untracked.split("\n")]
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Run the decision-assertions sensor. */
export function runDecisionAssertions(args: {
  mirrorPath: string;
  diff: DiffEntry[];
  decisions: DecisionFrontmatter[];
}): SensorResult {
  const startedAt = Date.now();
  const findings: SensorFinding[] = [];
  const reader = new MirrorFileReader(args.mirrorPath);
  const allFiles = listMirrorFiles(args.mirrorPath);

  for (const decision of args.decisions) {
    const assertions = decision.assertions ?? [];
    for (const a of assertions) {
      const result = evaluateAssertion({
        mirrorPath: args.mirrorPath,
        decision,
        assertion: a,
        diff: args.diff,
        reader,
        allFiles,
      });
      if (result === null) continue;
      findings.push(result);
    }
    // human_review_hint at the decision level (not assertion-level).
    if (decision.human_review_hint) {
      findings.push({
        sensor_id: SENSOR_ID,
        decision_id: decision.id,
        message: `human-review hint for ${decision.id}: ${decision.human_review_hint}`,
        severity: "soft",
      });
    }
  }

  const ok = findings.every((f) => f.severity !== "hard");
  return {
    sensor_id: SENSOR_ID,
    ok,
    duration_ms: Date.now() - startedAt,
    findings,
  };
}

function evaluateAssertion(args: {
  mirrorPath: string;
  decision: DecisionFrontmatter;
  assertion: DecisionAssertion;
  diff: DiffEntry[];
  reader: MirrorFileReader;
  allFiles: string[];
}): SensorFinding | null {
  const a = args.assertion;
  const ctx = { decision_id: args.decision.id, assertion_id: a.id };

  switch (a.kind) {
    case "schema_must_contain": {
      const candidates = args.allFiles.filter((p) => isSchemaFile(p));
      const tableRe = new RegExp(`\\b${escapeRegExp(a.table)}\\b`);
      const columnRe = new RegExp(`\\b${escapeRegExp(a.column)}\\b`);
      for (const path of candidates) {
        const text = args.reader.read(path);
        if (!text || !tableRe.test(text) || !columnRe.test(text)) continue;
        // Co-locate within ±10 lines.
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!tableRe.test(lines[i] ?? "")) continue;
          const lo = Math.max(0, i - 10);
          const hi = Math.min(lines.length - 1, i + 10);
          for (let j = lo; j <= hi; j++) {
            if (columnRe.test(lines[j] ?? "")) return null;
          }
        }
      }
      return finding(
        "hard",
        `${ctx.decision_id}/${ctx.assertion_id} requires schema column \`${a.table}.${a.column}\` — not found in mirror`,
        ctx,
      );
    }

    case "text_must_match": {
      const re = safeRegex(a.pattern);
      if (!re) return finding("soft", `${ctx.decision_id}/${ctx.assertion_id} pattern unparseable`, ctx);
      const inScope = args.allFiles.filter((p) => matchAnyGlob(p, a.in_globs));
      for (const path of inScope) {
        if (re.test(args.reader.read(path))) return null;
      }
      return finding(
        "hard",
        `${ctx.decision_id}/${ctx.assertion_id} text_must_match \`${a.pattern}\` — no file under ${a.in_globs.join(", ")} matches`,
        ctx,
      );
    }

    case "text_must_not_match": {
      const re = safeRegex(a.pattern);
      if (!re) return finding("soft", `${ctx.decision_id}/${ctx.assertion_id} pattern unparseable`, ctx);
      const inScope = args.allFiles.filter((p) => matchAnyGlob(p, a.in_globs));
      for (const path of inScope) {
        const text = args.reader.read(path);
        const m = re.exec(text);
        if (!m) continue;
        const line = lineOf(text, m.index);
        return finding(
          "hard",
          `${ctx.decision_id}/${ctx.assertion_id} text_must_not_match \`${a.pattern}\` — matched at ${path}:${line}`,
          { ...ctx, path, line, matched_text: m[0] },
        );
      }
      return null;
    }

    case "index_must_exist": {
      const candidates = args.allFiles.filter((p) => isSchemaFile(p));
      const colsPattern = a.columns
        .map((c) => `(?=.*\\b${escapeRegExp(c)}\\b)`)
        .join("");
      const re = new RegExp(
        `(?:CREATE\\s+(?:UNIQUE\\s+)?INDEX|index\\s*\\(.*\\bon\\s*:?\\s*['"\`]${escapeRegExp(a.table)}['"\`])[\\s\\S]{0,400}\\b${escapeRegExp(a.table)}\\b[\\s\\S]{0,400}${colsPattern}`,
        "i",
      );
      for (const path of candidates) {
        const text = args.reader.read(path);
        if (re.test(text)) {
          if (!a.where) return null;
          // If WHERE clause demanded, verify presence in same file.
          if (text.toLowerCase().includes(a.where.toLowerCase())) return null;
          return finding(
            "hard",
            `${ctx.decision_id}/${ctx.assertion_id} index_must_exist on ${a.table}(${a.columns.join(", ")}) WHERE ${a.where} — partial-index predicate not present in ${path}`,
            { ...ctx, path },
          );
        }
      }
      return finding(
        "hard",
        `${ctx.decision_id}/${ctx.assertion_id} index_must_exist on ${a.table}(${a.columns.join(", ")}) — not found in any schema-like file`,
        ctx,
      );
    }

    case "ast_pattern": {
      // No ast-grep engine is wired — the pattern is approximated as a text
      // regex. That approximation is only honest for the languages the
      // regex fallback handles; for anything else we must NOT report a hard
      // pass/fail we didn't actually check. Downgrade to a one-line advisory
      // (operator-chosen) so the rule is visibly text-only, never silent.
      const re = safeRegex(a.pattern);
      if (!re) return finding("soft", `${ctx.decision_id}/${ctx.assertion_id} pattern unparseable`, ctx);
      if (!AST_TEXT_APPROX.has(a.language.toLowerCase())) {
        return finding(
          "soft",
          `${ctx.decision_id}/${ctx.assertion_id} ast_pattern is advisory on \`${a.language}\` (no AST enforcement, and the text approximation is unreliable here) — verify \`${a.pattern}\` under ${a.in_globs.join(", ")} manually`,
          ctx,
        );
      }
      const inScope = args.allFiles.filter((p) => matchAnyGlob(p, a.in_globs));
      for (const path of inScope) {
        if (re.test(args.reader.read(path))) return null;
      }
      return finding(
        "hard",
        `${ctx.decision_id}/${ctx.assertion_id} ast_pattern (lang=${a.language}, text-approximated) \`${a.pattern}\` — no match under ${a.in_globs.join(", ")}`,
        ctx,
      );
    }

    case "file_must_not_be_modified": {
      const hit = args.diff.find((d) => d.path === a.path);
      if (!hit) return null;
      return finding(
        "hard",
        `${ctx.decision_id}/${ctx.assertion_id} file_must_not_be_modified — ${a.path} appears in diff (${hit.status})`,
        { ...ctx, path: a.path },
      );
    }

    case "query_must_filter_by": {
      // Approximate: search in_globs for table + each column appearing in the
      // same statement-ish window. For ORM=drizzle: `.where(and(...col1...col2...))`.
      const inScope = args.allFiles.filter((p) => matchAnyGlob(p, a.in_globs));
      const tableRef = new RegExp(`\\b${escapeRegExp(a.table)}\\b`);
      const combinator = a.require_combination === "and" ? /\band\s*\(/i : /\bor\s*\(/i;
      let anyHit = false;
      for (const path of inScope) {
        const text = args.reader.read(path);
        if (!tableRef.test(text)) continue;
        anyHit = true;
        // Find each `where(` window of 400 chars and check all columns.
        const whereRe = /\.where\s*\(/g;
        let m: RegExpExecArray | null;
        let allPresent = true;
        let saw = false;
        while ((m = whereRe.exec(text)) !== null) {
          saw = true;
          const win = text.slice(m.index, Math.min(text.length, m.index + 600));
          if (a.require_combination !== undefined && !combinator.test(win)) {
            allPresent = false;
            break;
          }
          for (const col of a.columns) {
            if (!new RegExp(`\\b${escapeRegExp(col)}\\b`).test(win)) {
              allPresent = false;
              break;
            }
          }
          if (!allPresent) break;
        }
        if (!saw) continue;
        if (allPresent) return null;
        const line = lineOf(text, (whereRe.exec(text) ?? { index: 0 }).index);
        return finding(
          "hard",
          `${ctx.decision_id}/${ctx.assertion_id} query_must_filter_by(${a.table}, [${a.columns.join(", ")}], ${a.require_combination}) — query in ${path}:${line} omits required column(s)`,
          { ...ctx, path, line },
        );
      }
      if (!anyHit) {
        return finding(
          "soft",
          `${ctx.decision_id}/${ctx.assertion_id} query_must_filter_by(${a.table}) — no query referencing this table found in scope; nothing to verify`,
          ctx,
        );
      }
      return null;
    }

    case "route_must_have_guard": {
      const inScope = args.allFiles.filter((p) => matchAnyGlob(p, a.in_globs));
      for (const path of inScope) {
        const text = args.reader.read(path);
        for (const required of a.require_on) {
          // Look for the required hook (e.g. method name, decorator) and
          // verify guard appears within 5 preceding lines.
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            if (!line.includes(required)) continue;
            const lo = Math.max(0, i - 8);
            const window = lines.slice(lo, i + 1).join("\n");
            if (window.includes(a.guard)) continue;
            return finding(
              "hard",
              `${ctx.decision_id}/${ctx.assertion_id} route_must_have_guard \`${a.guard}\` — \`${required}\` at ${path}:${i + 1} is not preceded by the guard`,
              { ...ctx, path, line: i + 1 },
            );
          }
        }
      }
      return null;
    }

    case "event_must_emit": {
      const inScope = args.allFiles.filter((p) => matchAnyGlob(p, a.in_globs));
      let any = false;
      for (const path of inScope) {
        const text = args.reader.read(path);
        const callRe = new RegExp(`\\b${escapeRegExp(a.after_method)}\\s*\\(`);
        if (!callRe.test(text)) continue;
        any = true;
        const emitRe = new RegExp(
          `\\.emit\\s*\\(\\s*['"\`]${escapeRegExp(a.event_key)}['"\`]`,
        );
        if (!emitRe.test(text)) {
          return finding(
            "hard",
            `${ctx.decision_id}/${ctx.assertion_id} event_must_emit \`${a.event_key}\` after \`${a.after_method}\` — no .emit() found in ${path}`,
            { ...ctx, path },
          );
        }
        if (a.payload_must_include && a.payload_must_include.length > 0) {
          for (const field of a.payload_must_include) {
            if (!new RegExp(`\\b${escapeRegExp(field)}\\b`).test(text)) {
              return finding(
                "hard",
                `${ctx.decision_id}/${ctx.assertion_id} event_must_emit payload missing field \`${field}\` in ${path}`,
                { ...ctx, path },
              );
            }
          }
        }
      }
      if (!any) {
        return finding(
          "soft",
          `${ctx.decision_id}/${ctx.assertion_id} event_must_emit — no call to \`${a.after_method}\` found in scope; nothing to verify`,
          ctx,
        );
      }
      return null;
    }

    case "service_method_must_call": {
      const inScope = args.allFiles.filter((p) => matchAnyGlob(p, a.in_globs));
      for (const path of inScope) {
        const text = args.reader.read(path);
        const methodRe = new RegExp(
          `\\b${escapeRegExp(a.in_method)}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{([\\s\\S]*?)\\n\\s*\\}`,
        );
        const m = methodRe.exec(text);
        if (!m) continue;
        const body = m[1] ?? "";
        const callRe = new RegExp(`\\b${escapeRegExp(a.must_call)}\\s*\\(`);
        if (callRe.test(body)) return null;
        const line = lineOf(text, m.index);
        return finding(
          "hard",
          `${ctx.decision_id}/${ctx.assertion_id} service_method_must_call — method \`${a.in_method}\` at ${path}:${line} does not call \`${a.must_call}\``,
          { ...ctx, path, line },
        );
      }
      return finding(
        "soft",
        `${ctx.decision_id}/${ctx.assertion_id} service_method_must_call — method \`${a.in_method}\` not found in scope; nothing to verify`,
        ctx,
      );
    }

    case "human_review_hint": {
      return finding(
        "soft",
        `${ctx.decision_id}/${ctx.assertion_id} human-review hint: ${a.description}`,
        ctx,
      );
    }
  }
}

function finding(
  severity: "hard" | "soft",
  message: string,
  ctx: {
    decision_id: string;
    assertion_id: string;
    path?: string;
    line?: number;
    matched_text?: string;
  },
): SensorFinding {
  const f: SensorFinding = {
    sensor_id: SENSOR_ID,
    decision_id: ctx.decision_id,
    assertion_id: ctx.assertion_id,
    message,
    severity,
  };
  if (ctx.path !== undefined) f.path = ctx.path;
  if (ctx.line !== undefined) f.line = ctx.line;
  if (ctx.matched_text !== undefined) f.matched_text = ctx.matched_text;
  return f;
}

function safeRegex(p: string): RegExp | null {
  try {
    return new RegExp(p, "m");
  } catch {
    return null;
  }
}



