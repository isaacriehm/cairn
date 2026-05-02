/**
 * Probe dispatcher — routes a UatProbe to the appropriate runner by kind.
 */

import type { ProbeRunResult, UatProbe } from "../types.js";
import { runCliProbe } from "./cli.js";
import { runHttpProbe } from "./http.js";
import { runIntegrationProbe } from "./integration.js";
import { runSqlProbe } from "./sql.js";
import { runUiProbe } from "./ui.js";

export interface ExecuteProbeOptions {
  /** Probe to run. */
  probe: UatProbe;
  /** http base URL fallback. */
  baseUrl?: string;
  /** Output directory under .harness/runs/active/<id>/uat/ for ui artifacts. */
  outputDir: string;
  /** Repo root — used by sql/integration probes to load probe config. */
  repoRoot?: string;
}

export async function executeProbe(opts: ExecuteProbeOptions): Promise<ProbeRunResult> {
  switch (opts.probe.kind) {
    case "http":
      return runHttpProbe({
        probe: opts.probe,
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      });
    case "cli":
      return runCliProbe({ probe: opts.probe });
    case "ui":
      return runUiProbe({ probe: opts.probe, outputDir: opts.outputDir });
    case "sql":
      return runSqlProbe({ probe: opts.probe, repoRoot: opts.repoRoot ?? process.cwd() });
    case "integration":
      return runIntegrationProbe({
        probe: opts.probe,
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
      });
  }
}

export { runCliProbe, runHttpProbe, runIntegrationProbe, runSqlProbe, runUiProbe };
