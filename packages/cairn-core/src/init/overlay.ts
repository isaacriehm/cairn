/**
 * Project-overlay config.yaml builder — extracted so both runInit
 * (terminal CLI) and the v0.2.0 MCP-native phase pipeline can call
 * it. Pure function; no IO.
 */

import { VERSION } from "../index.js";
import type { MapperOutput } from "./mapper.js";
import type { DetectionResult } from "./types.js";

const DEFAULT_OFF_LIMITS = [
  ".env",
  ".env.*",
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  "__pycache__/",
  "vendor/",
  ".venv/",
  ".direnv/",
  ".cache/",
  "coverage/",
];

interface BuildProjectOverlayArgs {
  detection: DetectionResult;
  decidedSlug: string;
  // Accepts either the full MapperOutput (CLI runInit path) or the
  // persisted-light projection without scope_index (MCP phase path);
  // overlay only consumes the small fields, so the structural subset
  // is sufficient.
  mapperOutput?: Omit<MapperOutput, "scope_index"> & {
    scope_index?: MapperOutput["scope_index"];
  };
}

export function buildProjectOverlay(
  args: BuildProjectOverlayArgs,
): Record<string, unknown> {
  const m = args.mapperOutput;
  const offLimits = [...DEFAULT_OFF_LIMITS];
  if (m !== undefined) {
    for (const x of m.off_limits_globs) {
      if (!offLimits.includes(x)) offLimits.push(x);
    }
  }

  // Only keys with a runtime reader are written. Detection-derived fields
  // (origin_url, stack_signatures, hook_capability, start_command) and the
  // never-executed proposed-sensors output are consumed only at init time —
  // persisting them produced dead config (audit Tier 2). `domain_summary`
  // is kept (read by `cairn fix`).
  //
  // high_stakes_globs lives ONLY under project_globs — the single location the
  // runtime reads (sensors/runner loadProjectGlobs; the top-level key was a
  // legacy fallback that duplicated this list; migration 0004 collapses it for
  // existing adopters).
  const overlay: Record<string, unknown> = {
    version: 1,
    cairn_version: VERSION,
    slug: args.decidedSlug,
    off_limits: offLimits,
    defer_hours: 24,
    project_globs: {
      route_handler_globs: m?.route_handler_globs ?? [],
      dto_globs: m?.dto_globs ?? [],
      generator_source_globs: m?.generator_source_globs ?? [],
      high_stakes_globs: m?.high_stakes_globs ?? [],
    },
  };
  if (m !== undefined) {
    overlay["domain_summary"] = m.domain_summary;
  }
  return overlay;
}
