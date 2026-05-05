/**
 * Project-overlay config.yaml builder — extracted so both runInit
 * (terminal CLI) and the v0.2.0 MCP-native phase pipeline can call
 * it. Pure function; no IO.
 */

import { VERSION } from "../index.js";
import type { MapperOutput } from "./mapper.js";
import type { DetectionResult } from "./types.js";

export const DEFAULT_OFF_LIMITS = [
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

export interface BuildProjectOverlayArgs {
  detection: DetectionResult;
  decidedSlug: string;
  mapperOutput?: MapperOutput;
}

export function buildProjectOverlay(
  args: BuildProjectOverlayArgs,
): Record<string, unknown> {
  const detected_sensor_commands = args.detection.proposed_sensors.map((s) => ({
    id: s.id,
    command: s.command,
    args: s.args,
    applies_to: s.applies_to,
    reason: s.reason,
  }));

  const m = args.mapperOutput;
  const offLimits = [...DEFAULT_OFF_LIMITS];
  if (m !== undefined) {
    for (const x of m.off_limits_globs) {
      if (!offLimits.includes(x)) offLimits.push(x);
    }
  }

  const overlay: Record<string, unknown> = {
    version: 1,
    cairn_version: VERSION,
    slug: args.decidedSlug,
    origin_url: args.detection.origin_url,
    stack_signatures: args.detection.stack_signatures.map((s) => s.kind),
    hook_capability: args.detection.hook_capability,
    start_command: args.detection.start_command,
    detected_sensor_commands,
    off_limits: offLimits,
    high_stakes_globs: m?.high_stakes_globs ?? [],
    project_globs: {
      route_handler_globs: m?.route_handler_globs ?? [],
      dto_globs: m?.dto_globs ?? [],
      generator_source_globs: m?.generator_source_globs ?? [],
      high_stakes_globs: m?.high_stakes_globs ?? [],
    },
  };
  if (m !== undefined) {
    overlay["pilot_module"] = m.pilot_module;
    overlay["domain_summary"] = m.domain_summary;
    overlay["key_modules"] = m.key_modules;
    overlay["mapper_proposed_sensors"] = m.proposed_sensors;
    if (m.notes.trim().length > 0) overlay["mapper_notes"] = m.notes;
  }
  return overlay;
}
