/**
 * Phase 13-multidev — detect per-host package manager(s) and emit
 * JOIN.md hints for new contributors. Also runs the final ground
 * manifest rebuild so the manifest reflects every DEC / INV Phase 9c
 * emitted; the post-commit hook + GC canary regenerate later, but a
 * freshly-adopted repo shouldn't need a commit before the manifest
 * is real. Idempotent.
 */

import { logger } from "../../logger.js";
import { writeManifest } from "@isaacriehm/cairn-state";
import {
  installMultiDev,
  type MultiDevInstallResult,
} from "../multi-dev/index.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

const log = logger("init.phases.13-multidev");

export async function runPhase13Multidev(state: PhaseState): Promise<PhaseResult> {
  try {
    const result: MultiDevInstallResult = installMultiDev({
      repoRoot: state.repoRoot,
    });

    let manifestFiles = 0;
    try {
      const m = writeManifest({ repoRoot: state.repoRoot, generator: "init.phase-13" });
      manifestFiles = m.manifest.files.length;
    } catch (err) {
      log.warn({ err: String(err) }, "phase 13 manifest rebuild failed (non-fatal)");
    }

    const next: PhaseState = {
      ...state,
      outputs: {
        ...state.outputs,
        "13-multidev": {
          ...result,
          manifest_files: manifestFiles,
        },
      },
    };
    return {
      status: "complete",
      nextPhase: null,
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "multidev-failed",
        message: "Multi-dev install failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
