/**
 * ui probe — Playwright via lazy-loaded `playwright` package.
 *
 * Phase 11 v1 ships the executor but does NOT add `playwright` to the pkg's
 * direct deps. Adopting projects that opt into UI probes run
 * `harness setup:uat-browsers` (Phase 16 init script will run this
 * automatically when the operator picks "set up E2E now"). Until then this
 * probe returns a structured "skipped" result so the bundle stays
 * well-formed.
 */

import { logger } from "../../logger.js";
import type { ProbeRunResult, UiProbe } from "../types.js";

const log = logger("uat.probe.ui");

let cachedPlaywright: unknown = null;
let cachedAttempt = false;

async function loadPlaywright(): Promise<unknown> {
  if (cachedAttempt) return cachedPlaywright;
  cachedAttempt = true;
  try {
    // Dynamic import keeps tsc happy even when playwright isn't installed.
    const mod = await import(
      /* @vite-ignore */ "playwright" as string
    ).catch(() => undefined);
    cachedPlaywright = mod ?? null;
  } catch {
    cachedPlaywright = null;
  }
  return cachedPlaywright;
}

export async function runUiProbe(args: {
  probe: UiProbe;
  outputDir: string;
}): Promise<ProbeRunResult> {
  const startedAt = Date.now();
  const pw = (await loadPlaywright()) as
    | { chromium?: { launch: (opts?: unknown) => Promise<unknown> } }
    | null;

  if (!pw || !pw.chromium) {
    return {
      probe_id: args.probe.id,
      probe_kind: "ui",
      passed: false,
      evidence: "playwright not installed",
      duration_ms: Date.now() - startedAt,
      skipped_reason:
        "playwright not installed; run `harness setup:uat-browsers` to enable ui probes",
    };
  }

  // Real implementation lands when playwright is in deps. Until then we
  // surface a structured fail so the bundle gate flags the AC.
  log.warn({ probe_id: args.probe.id }, "ui probe stub — playwright integration pending");
  void args.outputDir;
  return {
    probe_id: args.probe.id,
    probe_kind: "ui",
    passed: false,
    evidence: "ui probe runtime not yet wired; stub-only",
    duration_ms: Date.now() - startedAt,
    skipped_reason: "ui probe execution wires in a follow-up phase (Phase 11.5)",
  };
}
