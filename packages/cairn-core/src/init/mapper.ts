/**
 * Init mapper orchestrator (Tier 2 / Sonnet, with cheap Haiku merge).
 *
 * Three-stage pipeline:
 *
 *   1. `module-slicer` partitions the repo into ModuleSlices (one per
 *      detected module — submodules, workspace packages, top-level packages,
 *      or fallback heuristic). Single-package repos collapse to one slice.
 *   2. `mapper-parallel` dispatches one Sonnet call per slice in parallel
 *      (Promise.allSettled, 4-at-a-time batches when >8). Each call sees
 *      ~8k tokens of focused module input.
 *   3. `mapper-merge` runs a cheap Haiku call to pick the pilot module and
 *      synthesize the project domain summary; the rest of the merge is
 *      mechanical (union of arrays, dedupe sensors by id).
 *
 * If every module call fails, the orchestrator throws — there's no
 * fallback path. The operator re-runs `cairn init` with `--force` after
 * fixing whatever broke (auth, network, etc.).
 *
 * Public surface (`MapperOutput`, `MapperResult`, validators, prompt + schema
 * constants) is consumed by both this orchestrator and the standalone
 * `cairn scope rebuild` command.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
} from "../ground/ledgers.js";
import type {
  DecisionLedgerEntry,
  InvariantLedgerEntry,
} from "../ground/schemas.js";
import {
  MAPPER_OUTPUT_SCHEMA,
  MAPPER_SYSTEM_PROMPT,
  buildMapperUserPrompt,
} from "./mapper-prompts.js";
import {
  mapModulesParallel,
  type ModuleProposal,
} from "./mapper-parallel.js";
import { mergeModuleProposals } from "./mapper-merge.js";
import { inferGlobsFromDetection } from "./glob-inference.js";
import { sliceModules, type ModuleSlice } from "./module-slicer.js";
import type { DetectionResult } from "./types.js";
import type { RepoSummary } from "./walker.js";

const log = logger("init.mapper");

// ── Public types (unchanged shape) ──────────────────────────────────────────

export interface MapperKeyModule {
  name: string;
  path: string;
  purpose: string;
}

export interface MapperProposedSensor {
  id: string;
  description: string;
  applies_to_globs: string[];
}

export interface MapperScopeIndexEntry {
  decisions: string[];
  invariants: string[];
  unscoped?: boolean;
}

export interface MapperScopeIndex {
  files: Record<string, MapperScopeIndexEntry>;
}

export interface MapperOutput {
  pilot_module: string;
  domain_summary: string;
  key_modules: MapperKeyModule[];
  route_handler_globs: string[];
  dto_globs: string[];
  generator_source_globs: string[];
  high_stakes_globs: string[];
  off_limits_globs: string[];
  proposed_sensors: MapperProposedSensor[];
  notes: string;
  scope_index: MapperScopeIndex;
}

export interface MapperResult {
  output: MapperOutput;
  duration_ms: number;
  tier: "sonnet";
  model: string;
  /** Per-module proposals from the parallel pipeline. */
  module_proposals?: ModuleProposal[];
  /** Total slices detected before MAPPER_SLICE_CAP was applied. */
  slices_detected: number;
  /** True when the slicer hit MAPPER_SLICE_CAP and was sliced. */
  truncated_at_slice_cap: boolean;
}

/**
 * Hard cap on per-module Sonnet calls. The mapper dispatches one call per
 * slice in parallel rounds of 4. Above this cap a 200-package monorepo
 * spends 25+ minutes on adoption with rate-limit risk on the operator's
 * Claude plan. Operator can re-run `cairn scope rebuild` later with a
 * narrower scope to extend coverage.
 */
const MAPPER_SLICE_CAP = 50;

// ── Re-exports — `cairn scope rebuild` and other consumers import these. ──

export { MAPPER_OUTPUT_SCHEMA, MAPPER_SYSTEM_PROMPT, buildMapperUserPrompt };

function isMapperOutput(value: unknown): value is MapperOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    !(
      typeof v["pilot_module"] === "string" &&
      typeof v["domain_summary"] === "string" &&
      Array.isArray(v["key_modules"]) &&
      Array.isArray(v["route_handler_globs"]) &&
      Array.isArray(v["dto_globs"]) &&
      Array.isArray(v["generator_source_globs"]) &&
      Array.isArray(v["high_stakes_globs"]) &&
      Array.isArray(v["off_limits_globs"]) &&
      Array.isArray(v["proposed_sensors"]) &&
      typeof v["notes"] === "string"
    )
  ) {
    return false;
  }
  const scopeIdxRaw = v["scope_index"];
  if (scopeIdxRaw !== undefined) {
    if (typeof scopeIdxRaw !== "object" || scopeIdxRaw === null) return false;
    const filesRaw = (scopeIdxRaw as Record<string, unknown>)["files"];
    if (typeof filesRaw !== "object" || filesRaw === null) return false;
  }
  return true;
}

export function validateMapperOutput(value: unknown): MapperOutput {
  if (!isMapperOutput(value)) {
    throw new Error(
      `mapper output failed shape validation: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }
  const out = value as MapperOutput & { scope_index?: MapperOutput["scope_index"] };
  if (out.scope_index === undefined) {
    out.scope_index = { files: {} };
  }
  return out as MapperOutput;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export interface RunMapperArgs {
  detection: DetectionResult;
  /**
   * Pre-built repo summary from the Phase-1 walker. Used by both the chunked
   * path (its merge step references the workspace top-level package.json
   * via repoRoot) and the single-call fallback (consumes summary directly).
   */
  summary: RepoSummary;
  /** Repo root absolute path — slicer + ledger read from here. */
  repoRoot: string;
  /** Fires once after slicing, before any module call goes out. */
  onSlicesDetected?: (slices: ModuleSlice[]) => void;
  /** Optional progress callback fired as each module proposal completes. */
  onModuleStart?: (slice: ModuleSlice) => void;
  onModuleEnd?: (slice: ModuleSlice, proposal: ModuleProposal) => void;
}

export async function runMapper(args: RunMapperArgs): Promise<MapperResult> {
  const startedAt = Date.now();

  // 1. Slice the repo into modules. The slicer always returns at least one
  //    slice (single-package repos get one whole-repo slice). MAPPER_SLICE_CAP
  //    bounds large monorepos — slicer truncates deterministically.
  const allSlices = sliceModules({ repoRoot: args.repoRoot });
  const slicesDetected = allSlices.length;
  const truncatedAtSliceCap = slicesDetected > MAPPER_SLICE_CAP;
  const slices = truncatedAtSliceCap
    ? allSlices.slice(0, MAPPER_SLICE_CAP)
    : allSlices;
  const decisions = readLedgerSafely(args.repoRoot, "decisions");
  const invariants = readLedgerSafely(args.repoRoot, "invariants");
  if (args.onSlicesDetected !== undefined) args.onSlicesDetected(slices);

  if (truncatedAtSliceCap) {
    log.warn(
      { slicesDetected, cap: MAPPER_SLICE_CAP },
      "mapper truncated to slice cap; operator can extend coverage with `cairn scope rebuild`",
    );
  }
  log.info(
    {
      slices: slices.length,
      slices_detected: slicesDetected,
      truncated: truncatedAtSliceCap,
      slice_slugs: slices.map((s) => s.moduleSlug),
      decisions: decisions.length,
      invariants: invariants.length,
    },
    "chunked mapper dispatch",
  );

  // 2. Parallel module calls.
  const proposals = await mapModulesParallel({
    slices,
    decisions,
    invariants,
    ...(args.onModuleStart !== undefined ? { onModuleStart: args.onModuleStart } : {}),
    ...(args.onModuleEnd !== undefined ? { onModuleEnd: args.onModuleEnd } : {}),
  });

  // 3. If every module call failed there's no fallback — surface the
  //    error so the operator can re-run after fixing the upstream cause.
  const allFailed = proposals.length > 0 && proposals.every((p) => p.failed);
  if (allFailed) {
    throw new Error(
      `mapper failed: all ${proposals.length} module call(s) returned errors. ` +
        `Re-run \`cairn init --force\` after fixing the upstream cause (auth, network, etc.).`,
    );
  }

  // 4. Merge call (Haiku).
  const workspacePackageJson = readIfExists(join(args.repoRoot, "package.json"));
  const inferredGlobs = inferGlobsFromDetection(args.detection, args.repoRoot);
  const merged = await mergeModuleProposals({
    proposals,
    workspacePackageJson,
    projectSlug: args.detection.project_slug,
    detectionSensors: args.detection.proposed_sensors,
    inferredGlobs,
  });

  log.info(
    {
      proposals: proposals.length,
      successful: proposals.filter((p) => !p.failed).length,
      pilot_module: merged.pilot_module,
      total_sensors: merged.proposed_sensors.length,
    },
    "chunked mapper complete",
  );

  return {
    output: merged,
    tier: "sonnet",
    model: "haiku+sonnet",
    duration_ms: Date.now() - startedAt,
    module_proposals: proposals,
    slices_detected: slicesDetected,
    truncated_at_slice_cap: truncatedAtSliceCap,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readLedgerSafely(repoRoot: string, kind: "decisions"): DecisionLedgerEntry[];
function readLedgerSafely(repoRoot: string, kind: "invariants"): InvariantLedgerEntry[];
function readLedgerSafely(
  repoRoot: string,
  kind: "decisions" | "invariants",
): DecisionLedgerEntry[] | InvariantLedgerEntry[] {
  // Ground state may not exist on first-run adopters. Empty list is fine —
  // mapper just gets no in-scope ledger context to classify against.
  try {
    const groundDir = join(repoRoot, ".cairn", "ground");
    if (!existsSync(groundDir)) return [];
    return kind === "decisions"
      ? buildDecisionsLedger({ repoRoot })
      : buildInvariantsLedger({ repoRoot });
  } catch (err) {
    log.warn({ err: String(err), kind }, "ledger read failed; using empty list");
    return [];
  }
}
