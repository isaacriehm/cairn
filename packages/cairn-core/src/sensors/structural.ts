/**
 * Layer C — generic project-agnostic structural sensors.
 *
 * Triggered when the diff touches files matching the project's glob keys.
 * Each sensor inspects the POST-change content of those files (not just
 * the diff) — Layer C is "do these load-bearing files follow contract",
 * which is stricter than Layer A's "did this run add new debt".
 *
 *   route-handler-non-empty — every method in a route/controller class has a
 *                             non-trivial body. Catches "added handler that
 *                             does nothing" disguised as completion.
 *   dto-no-fake-fields      — @IsOptional() fields with no other validator
 *                             are fake-thoroughness; they look like work and
 *                             do nothing.
 *
 * Both are pattern-based; profiles plug stack-specific globs. The regex is
 * intentionally conservative (false-negatives over false-positives) — sensors
 * that fail-loud-on-noise get disabled which defeats the purpose.
 */

import { lineOf, matchAnyGlob } from "@isaacriehm/cairn-state";
import type { DiffEntry, SensorFinding, SensorResult } from "./types.js";

const ROUTE_SENSOR_ID = "route-handler-non-empty";
const DTO_SENSOR_ID = "dto-no-fake-fields";

/** Method body that's effectively a no-op — language-agnostic regex. */
const EMPTY_BODY_PATTERNS: { regex: RegExp; reason: string }[] = [
  // TypeScript/JavaScript class method with empty body or null/undefined return.
  {
    regex: /^\s*(?:public|private|protected|async)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*(?:return\s*(?:null|undefined)?\s*;?)?\s*\}/gm,
    reason: "empty / return-null / return-undefined body",
  },
  // throw new Error('not implemented').
  {
    regex: /\b(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*throw\s+new\s+Error\s*\(\s*['"`][^'"`]*not[\s_]?implemented/gi,
    reason: "throws not-implemented",
  },
  // Python: `def foo(...): pass` with nothing else.
  {
    regex: /def\s+(\w+)\s*\([^)]*\)\s*(?:->[^:]+)?:\s*\n\s*pass\s*\n/g,
    reason: "Python def with `pass` body",
  },
  // Python: `def foo(...): return None`.
  {
    regex: /def\s+(\w+)\s*\([^)]*\)\s*(?:->[^:]+)?:\s*\n\s*return(?:\s+None)?\s*\n/g,
    reason: "Python def returning None",
  },
];

/** Detect a class context for TypeScript/JavaScript controllers. */
const TS_CONTROLLER_HINT = /\bclass\s+\w+(?:Controller|Resource|Resolver|Handler)\b|@(?:Controller|Resource|Resolver|Handler)\b|extends\s+(?:Controller|Resource)\b/;

/** Detect Python route registration. */
const PY_ROUTE_HINT = /@(?:app|router|blueprint|bp)\.(?:get|post|put|patch|delete|route)\b|@route\b|class\s+\w+(?:View|Resource)\b/;

/** Run route-handler-non-empty against changed files matching globs. */
export function runRouteHandlerNonEmpty(args: {
  diff: DiffEntry[];
  globs: string[] | undefined;
}): SensorResult {
  const startedAt = Date.now();
  const findings: SensorFinding[] = [];
  if (!args.globs || args.globs.length === 0) {
    return {
      sensor_id: ROUTE_SENSOR_ID,
      ok: true,
      duration_ms: Date.now() - startedAt,
      findings,
      skipped: { reason: "route_handler_globs not configured for this project" },
    };
  }
  const inScope = args.diff.filter(
    (d) => d.status !== "deleted" && matchAnyGlob(d.path, args.globs ?? []),
  );
  if (inScope.length === 0) {
    return {
      sensor_id: ROUTE_SENSOR_ID,
      ok: true,
      duration_ms: Date.now() - startedAt,
      findings,
      skipped: { reason: "no diff entries match route_handler_globs" },
    };
  }
  for (const entry of inScope) {
    const text = entry.afterContent ?? "";
    if (text.length === 0) continue;
    if (!isRouteHandlerFile(entry.path, text)) continue;
    for (const { regex, reason } of EMPTY_BODY_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const methodName = m[1] ?? "<anon>";
        if (METHOD_ALLOWLIST.has(methodName)) continue;
        const line = lineOf(text, m.index);
        findings.push({
          sensor_id: ROUTE_SENSOR_ID,
          path: entry.path,
          line,
          matched_text: m[0].slice(0, 200),
          message: `${entry.path}:${line} route-handler method \`${methodName}\` — ${reason}`,
          severity: "hard",
        });
        if (re.lastIndex === m.index) re.lastIndex += 1;
      }
    }
  }
  return {
    sensor_id: ROUTE_SENSOR_ID,
    ok: findings.length === 0,
    duration_ms: Date.now() - startedAt,
    findings,
  };
}

/** Run dto-no-fake-fields against changed files matching globs. */
export function runDtoNoFakeFields(args: {
  diff: DiffEntry[];
  globs: string[] | undefined;
}): SensorResult {
  const startedAt = Date.now();
  const findings: SensorFinding[] = [];
  if (!args.globs || args.globs.length === 0) {
    return {
      sensor_id: DTO_SENSOR_ID,
      ok: true,
      duration_ms: Date.now() - startedAt,
      findings,
      skipped: { reason: "dto_globs not configured for this project" },
    };
  }
  const inScope = args.diff.filter(
    (d) => d.status !== "deleted" && matchAnyGlob(d.path, args.globs ?? []),
  );
  if (inScope.length === 0) {
    return {
      sensor_id: DTO_SENSOR_ID,
      ok: true,
      duration_ms: Date.now() - startedAt,
      findings,
      skipped: { reason: "no diff entries match dto_globs" },
    };
  }
  for (const entry of inScope) {
    const text = entry.afterContent ?? "";
    if (text.length === 0) continue;
    findings.push(...findFakeOptionalFields(entry.path, text));
  }
  return {
    sensor_id: DTO_SENSOR_ID,
    ok: findings.every((f) => f.severity !== "hard"),
    duration_ms: Date.now() - startedAt,
    findings,
  };
}

/**
 * `@IsOptional()` followed by a property declaration with NO additional
 * validator decorator on the same or preceding line(s). Capture group 1 is
 * the field name.
 */
function findFakeOptionalFields(path: string, text: string): SensorFinding[] {
  const findings: SensorFinding[] = [];
  // Match `@IsOptional()\n  fieldName?: Type;` with no other validator.
  const re = /@IsOptional\s*\(\s*\)\s*\n((?:\s*@[A-Z]\w+\s*\([^)]*\)\s*\n)*)\s*(\w+)\s*\??\s*:\s*[^;\n]+;?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const otherDecorators = m[1] ?? "";
    const field = m[2] ?? "";
    // If only `@IsOptional()` and nothing else, that's fake-thoroughness.
    if (otherDecorators.trim().length === 0) {
      const line = lineOf(text, m.index);
      findings.push({
        sensor_id: DTO_SENSOR_ID,
        path,
        line,
        matched_text: m[0].slice(0, 200),
        message: `${path}:${line} field \`${field}\` decorated only with @IsOptional() — add a validator (@IsString, @IsNumber, etc.) or remove the decorator`,
        severity: "soft",
      });
    }
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return findings;
}

/** Methods we don't want to flag: constructors, framework hooks, etc. */
const METHOD_ALLOWLIST = new Set<string>([
  "constructor",
  "ngOnInit",
  "ngOnDestroy",
  "onModuleInit",
  "onModuleDestroy",
  "onApplicationBootstrap",
  "onApplicationShutdown",
  "render",
]);

/** Heuristic: file LOOKS like a route/controller before regex-scanning bodies. */
function isRouteHandlerFile(path: string, text: string): boolean {
  if (TS_CONTROLLER_HINT.test(text)) return true;
  if (PY_ROUTE_HINT.test(text)) return true;
  // Conservative fallback — if the path matches the glob but the file doesn't
  // declare a class or route decorator, skip rather than false-positive.
  void path;
  return false;
}

/** 1-based line number from a character offset. */


