/**
 * integration probe — placeholder. Phase 11.6 implements this with
 * docker-compose orchestration when operator opts in at adoption.
 */

import type { IntegrationProbe, ProbeRunResult } from "../types.js";

export async function runIntegrationProbe(args: {
  probe: IntegrationProbe;
}): Promise<ProbeRunResult> {
  return {
    probe_id: args.probe.id,
    probe_kind: "integration",
    passed: false,
    evidence: "integration probe not yet implemented",
    duration_ms: 0,
    skipped_reason: "integration probe runtime is Phase 11.6; configure via init",
  };
}
