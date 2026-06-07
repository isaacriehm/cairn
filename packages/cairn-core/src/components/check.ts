/**
 * Component check — the registry gate.
 *
 * Validates `@cairn` source headers and projects findings into the shared
 * SensorFinding shape so the pre-commit hook, `cairn doctor`, and the
 * attention queue all consume one result. Hard findings block; soft findings
 * warn. Advisory-vs-gate is never blurred — the *audit* (audit.ts) advises;
 * this check gates (port invariant 5).
 *
 * Note: the source prototype treated a stale INDEX.md as a check error. That
 * semantic is dropped here because the index is derived + gitignored (D3) —
 * "stale across clones" is meaningless. doctor / `cairn components check`
 * rebuild fresh in memory; the pre-commit path validates staged headers.
 */

import {
  collectComponents,
  hasComponentConfig,
  loadComponentsConfig,
  validateComponents,
} from "@isaacriehm/cairn-state";
import type { SensorFinding } from "../sensors/types.js";

export interface ComponentCheckResult {
  findings: SensorFinding[];
  hardFailures: number;
  softFindings: number;
  /** Components indexed across all workspaces. */
  total: number;
  workspaces: number;
}

export interface ComponentCheckOptions {
  /**
   * When set, only surface findings whose file is in this set (repo-relative
   * POSIX). The full repo is still collected so cross-file findings
   * (duplicate names) resolve correctly — we just narrow what's reported to
   * the staged change. Used by the pre-commit gate.
   */
  files?: string[];
}

export function runComponentCheck(
  repoRoot: string,
  opts: ComponentCheckOptions = {},
): ComponentCheckResult {
  const config = loadComponentsConfig(repoRoot);
  if (!hasComponentConfig(config)) {
    return { findings: [], hardFailures: 0, softFindings: 0, total: 0, workspaces: 0 };
  }

  const collected = collectComponents(repoRoot, config);
  let findings = validateComponents(collected, config);

  if (opts.files !== undefined) {
    const staged = new Set(opts.files);
    findings = findings.filter((f) => f.file === undefined || staged.has(f.file));
  }

  const sensorFindings: SensorFinding[] = findings.map((f) => ({
    sensor_id: "component-registry",
    ...(f.file !== undefined ? { path: f.file } : {}),
    message: f.message,
    severity: f.severity,
  }));

  const hardFailures = sensorFindings.filter((f) => f.severity === "hard").length;
  const softFindings = sensorFindings.filter((f) => f.severity === "soft").length;

  return {
    findings: sensorFindings,
    hardFailures,
    softFindings,
    total: collected.components.length,
    workspaces: config.workspaces.length,
  };
}
