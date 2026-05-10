/**
 * Side-file persistence for the heavy mapper output.
 *
 * Phase 3-mapper produces a `MapperResult` whose `output.scope_index.files`
 * map and `module_proposals` array dominate the payload size — on a real
 * monorepo the combined JSON crosses 90KB, far above what the MCP transport
 * can echo back in a tool result without spilling. To keep
 * `.cairn/init-state.json` skinny enough that the cairn-adopt skill can
 * thread it through the LLM without spilling, the heavy fields live in
 * `.cairn/init/mapper-output.json` instead. State carries only the
 * persisted-light projection (small globs, key modules, domain summary,
 * mechanical sensor list, run metadata).
 *
 * Phase 4-seed reloads the full mapper output via `readMapperOutputFile`
 * to write `.cairn/ground/scope-index.yaml`. Other downstream phases
 * only need the light fields, so they read from `state.outputs["3-mapper"]`
 * directly.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { MapperResult, MapperOutput } from "../mapper.js";

/** Filename relative to repoRoot. */
export const MAPPER_OUTPUT_PATH = join(".cairn", "init", "mapper-output.json");

export function mapperOutputAbsPath(repoRoot: string): string {
  return join(repoRoot, MAPPER_OUTPUT_PATH);
}

/**
 * Atomically write the full mapper result. Creates `.cairn/init/` if needed.
 */
export function writeMapperOutputFile(
  repoRoot: string,
  full: MapperResult,
): string {
  const abs = mapperOutputAbsPath(repoRoot);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2), "utf8");
  renameSync(tmp, abs);
  return abs;
}

/**
 * Read the full mapper result from `.cairn/init/mapper-output.json`.
 * Returns null if missing or unreadable. Phase 3b-seed calls this to
 * obtain the scope_index used to seed `.cairn/ground/scope-index.yaml`.
 */
export function readMapperOutputFile(repoRoot: string): MapperResult | null {
  const abs = mapperOutputAbsPath(repoRoot);
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as MapperResult;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persisted-light projection of MapperResult that lives inside
 * `state.outputs["3-mapper"]`. The heavy fields (scope_index.files,
 * module_proposals) are stripped — readers that need them call
 * `readMapperOutputFile` against the repo root.
 */
export interface MapperResultPersisted {
  output: Omit<MapperOutput, "scope_index">;
  duration_ms: number;
  tier: "sonnet";
  model: string;
  slices_detected: number;
  truncated_at_slice_cap: boolean;
}

/** Strip the heavy fields from a fresh MapperResult for state persistence. */
export function toMapperResultPersisted(
  full: MapperResult,
): MapperResultPersisted {
  const {
    scope_index: _omitScope,
    ...outputLight
  } = full.output;
  return {
    output: outputLight,
    duration_ms: full.duration_ms,
    tier: full.tier,
    model: full.model,
    slices_detected: full.slices_detected,
    truncated_at_slice_cap: full.truncated_at_slice_cap,
  };
}
