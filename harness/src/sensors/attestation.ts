/**
 * Layer B — attestation cross-check.
 *
 * The agent emits a fenced YAML block at the end of its final response.
 * This module:
 *   1. Extracts the YAML block from the agent's final text.
 *   2. Parses it into a structured `Attestation`.
 *   3. Cross-checks every claim against the actual diff. Mismatch = lie.
 *
 * Per PRIMER §10 Layer B. Lying must be harder than telling truth.
 */

import { parse as parseYaml } from "yaml";
import { matchAnyGlob } from "../ground/glob.js";
import type {
  Attestation,
  DiffEntry,
  SensorFinding,
  SensorResult,
  StubCatalog,
} from "./types.js";
import { detectStubMatches } from "./stub-catalog.js";

const SENSOR_ID = "attestation-cross-check";

/**
 * Extract the YAML block from a final assistant message. The template
 * instructs the agent to emit a fenced block whose first line is the literal
 * key `attestation:`. We accept either:
 *
 *   ```yaml
 *   attestation:
 *     ...
 *   ```
 *
 * or a bare top-level YAML doc starting with `attestation:`.
 */
export function extractAttestation(text: string): Attestation | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;

  // Prefer fenced ```yaml ... ``` block whose body starts with `attestation:`.
  const fenced = /```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    const body = match[1] ?? "";
    if (/^\s*attestation\s*:/m.test(body)) {
      const parsed = parseAttestationBody(body);
      if (parsed) return parsed;
    }
  }

  // Fallback: bare YAML in text starting with `attestation:`.
  const bareIdx = text.search(/^\s*attestation\s*:/m);
  if (bareIdx !== -1) {
    const slice = text.slice(bareIdx);
    return parseAttestationBody(slice);
  }
  return undefined;
}

/** Try parsing a YAML body that contains an `attestation:` key. */
function parseAttestationBody(body: string): Attestation | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(body);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const root = doc as Record<string, unknown>;
  const at = root["attestation"];
  if (typeof at !== "object" || at === null) return undefined;
  const a = at as Record<string, unknown>;

  const delivered = Array.isArray(a["delivered"])
    ? (a["delivered"] as Record<string, unknown>[]).map((d) => ({
        symbol: String(d["symbol"] ?? ""),
        ...(typeof d["path"] === "string" ? { path: d["path"] } : {}),
        behavior: ((): "full" | "partial" | "scaffolded" => {
          const v = d["behavior"];
          return v === "partial" || v === "scaffolded" ? v : "full";
        })(),
        ...(Array.isArray(d["sensors_passed"])
          ? { sensors_passed: (d["sensors_passed"] as string[]).map(String) }
          : {}),
      }))
    : [];
  const deferred = Array.isArray(a["deferred"])
    ? (a["deferred"] as Record<string, unknown>[]).map((d) => ({
        symbol: String(d["symbol"] ?? ""),
        reason: String(d["reason"] ?? ""),
      }))
    : [];
  const known_limitations = Array.isArray(a["known_limitations"])
    ? (a["known_limitations"] as unknown[]).map(String)
    : [];
  const todos_introduced = typeof a["todos_introduced"] === "number" ? a["todos_introduced"] : 0;
  const stubs_introduced = typeof a["stubs_introduced"] === "number" ? a["stubs_introduced"] : 0;
  const files_touched = Array.isArray(a["files_touched"])
    ? (a["files_touched"] as unknown[]).map(String)
    : [];

  const out: Attestation = {
    delivered,
    deferred,
    known_limitations,
    todos_introduced,
    stubs_introduced,
    files_touched,
  };

  // Optional blocked_by from the same root or under attestation.
  const block = (root["blocked_by"] ?? a["blocked_by"]) as unknown;
  if (typeof block === "object" && block !== null) {
    const b = block as Record<string, unknown>;
    if (typeof b["reason"] === "string") {
      out.blocked_by = {
        reason: b["reason"],
        ...(typeof b["needed_from_operator"] === "string"
          ? { needed_from_operator: b["needed_from_operator"] }
          : {}),
      };
    }
  }
  return out;
}

/**
 * Cross-check the attestation against the diff. Returns the sensor result.
 *
 * Hard fails:
 *   - attestation absent or unparseable
 *   - files_touched mismatches actual changed paths (set-equality)
 *   - todos_introduced != count of TODO/FIXME/XXX/HACK markers added
 *   - stubs_introduced != count of hard-severity stub-pattern hits
 *   - any delivered item declared `behavior: full` whose path/text contains
 *     a stub-pattern hit (lying about completeness)
 */
export function runAttestationCrossCheck(args: {
  attestation: Attestation | undefined;
  diff: DiffEntry[];
  stubCatalog: StubCatalog;
  /** Globs of files always allowed in diff but not required to be in
   *  files_touched (e.g. `.harness/runs/active/**`). */
  ignoreGlobs?: string[];
}): SensorResult {
  const startedAt = Date.now();
  const findings: SensorFinding[] = [];

  if (!args.attestation) {
    findings.push({
      sensor_id: SENSOR_ID,
      message:
        "agent emitted no `attestation:` YAML block in final response — Layer B contract requires one",
      severity: "hard",
    });
    return {
      sensor_id: SENSOR_ID,
      ok: false,
      duration_ms: Date.now() - startedAt,
      findings,
    };
  }

  if (args.attestation.blocked_by) {
    // Agent declared it can't proceed. Surface as soft so the orchestrator
    // routes it back to the operator instead of looping.
    findings.push({
      sensor_id: SENSOR_ID,
      message: `agent reported blocked_by: ${args.attestation.blocked_by.reason}`,
      severity: "soft",
    });
  }

  const diffPaths = new Set(
    args.diff
      .filter((d) => d.status !== "deleted")
      .map((d) => d.path),
  );
  const ignore = args.ignoreGlobs ?? [];
  const declared = new Set(args.attestation.files_touched);

  // Set-equality: every changed file must be declared, and every declared
  // file must be in the diff (catches "I changed these other files too" lies).
  for (const path of diffPaths) {
    if (declared.has(path)) continue;
    if (ignore.length > 0 && matchAnyGlob(path, ignore)) continue;
    findings.push({
      sensor_id: SENSOR_ID,
      path,
      message: `file changed but not in attestation.files_touched: ${path}`,
      severity: "hard",
    });
  }
  for (const path of declared) {
    if (diffPaths.has(path)) continue;
    findings.push({
      sensor_id: SENSOR_ID,
      path,
      message: `attestation.files_touched lists a file not actually changed: ${path}`,
      severity: "hard",
    });
  }

  // Count markers added in the diff.
  const addedTodoCount = countAddedMarkers(args.diff);
  if (args.attestation.todos_introduced !== addedTodoCount) {
    findings.push({
      sensor_id: SENSOR_ID,
      message: `attestation.todos_introduced=${args.attestation.todos_introduced} but diff adds ${addedTodoCount} TODO/FIXME/XXX/HACK marker(s)`,
      severity: "hard",
    });
  }

  // Count hard-stub matches in the diff.
  const stubHits = detectStubMatches({
    diff: args.diff,
    catalog: args.stubCatalog,
    /** All languages — Layer B doesn't get to filter by profile (the agent's
     *  number must match the same denominator we'll use). */
    languages: undefined,
  });
  const hardStubCount = stubHits.filter((h) => h.severity === "hard").length;
  if (args.attestation.stubs_introduced !== hardStubCount) {
    findings.push({
      sensor_id: SENSOR_ID,
      message: `attestation.stubs_introduced=${args.attestation.stubs_introduced} but Layer A finds ${hardStubCount} hard-severity stub pattern(s)`,
      severity: "hard",
    });
  }

  // behavior:full + stub-pattern coexistence = lie about completeness.
  for (const d of args.attestation.delivered) {
    if (d.behavior !== "full") continue;
    const matches = stubHits.filter((h) => {
      if (d.path && h.path !== d.path) return false;
      // If no path, just see whether any matched_text references the symbol.
      if (!d.path) return (h.matched_text ?? "").includes(d.symbol);
      return true;
    });
    for (const m of matches) {
      const f: SensorFinding = {
        sensor_id: SENSOR_ID,
        message: `delivered "${d.symbol}" claimed behavior:full but contains stub pattern \`${m.pattern_id}\``,
        severity: "hard",
      };
      if (m.path !== undefined) f.path = m.path;
      if (m.line !== undefined) f.line = m.line;
      if (m.matched_text !== undefined) f.matched_text = m.matched_text;
      if (m.pattern_id !== undefined) f.pattern_id = m.pattern_id;
      findings.push(f);
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

/**
 * Count TODO/FIXME/XXX/HACK markers introduced in the diff (added lines only).
 * Modified files: counts markers in content not present at the SHA pin.
 * Added files: counts every marker.
 */
function countAddedMarkers(diff: DiffEntry[]): number {
  const re = /(?:\/\/|#|\/\*|--)\s*(TODO|FIXME|XXX|HACK)\b/g;
  let total = 0;
  for (const entry of diff) {
    if (entry.status === "deleted") continue;
    const after = entry.afterContent ?? "";
    const before = entry.beforeContent ?? "";
    const beforeCount = (before.match(re) ?? []).length;
    const afterCount = (after.match(re) ?? []).length;
    total += Math.max(0, afterCount - beforeCount);
  }
  return total;
}
