/**
 * sql probe — placeholder. Phase 11.6 implements this when operator opts
 * in to sql probes at adoption (init script provisions a DB connection
 * config and the appropriate client lib).
 */

import type { ProbeRunResult, SqlProbe } from "../types.js";

export async function runSqlProbe(args: { probe: SqlProbe }): Promise<ProbeRunResult> {
  return {
    probe_id: args.probe.id,
    probe_kind: "sql",
    passed: false,
    evidence: "sql probe not yet implemented",
    duration_ms: 0,
    skipped_reason: "sql probe runtime is Phase 11.6; configure via init",
  };
}
