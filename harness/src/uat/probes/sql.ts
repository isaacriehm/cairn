/**
 * sql probe — dispatches to the configured driver (v1 sqlite live; pg/mysql
 * placeholders).
 */

import { logger } from "../../logger.js";
import type { ProbeRunResult, SqlProbe } from "../types.js";
import {
  resolveConnection,
  runQuery,
  SqlConnectionMissingError,
} from "./sql/index.js";

const log = logger("uat.probe.sql");

export async function runSqlProbe(args: {
  probe: SqlProbe;
  repoRoot: string;
}): Promise<ProbeRunResult> {
  const startedAt = Date.now();
  const probe = args.probe;

  // Defense-in-depth: reject anything that isn't a SELECT/SHOW.
  if (!/^\s*(SELECT|WITH|SHOW|EXPLAIN|PRAGMA)\b/i.test(probe.query)) {
    return {
      probe_id: probe.id,
      probe_kind: "sql",
      passed: false,
      evidence: probe.query.slice(0, 200),
      duration_ms: Date.now() - startedAt,
      failure_reason: "sql probe rejects non-SELECT queries (DDL/DML must not run as a probe)",
    };
  }

  const resolved = resolveConnection(args.repoRoot, probe.connection);
  if (!resolved) {
    return {
      probe_id: probe.id,
      probe_kind: "sql",
      passed: false,
      evidence: `connection "${probe.connection}" not configured`,
      duration_ms: Date.now() - startedAt,
      skipped_reason:
        `connection "${probe.connection}" missing from .harness/config/probes/sql.yaml — run \`harness setup:uat-sql\``,
    };
  }

  let queryResult;
  try {
    queryResult = await runQuery({
      repoRoot: args.repoRoot,
      connectionKey: probe.connection,
      sql: probe.query,
    });
  } catch (err) {
    if (err instanceof SqlConnectionMissingError) {
      return {
        probe_id: probe.id,
        probe_kind: "sql",
        passed: false,
        evidence: err.message,
        duration_ms: Date.now() - startedAt,
        skipped_reason: err.message,
      };
    }
    const msg = String(err);
    // Distinguish "driver not installed" (skipped) from query error (failed).
    if (/not installed|not yet implemented/i.test(msg)) {
      return {
        probe_id: probe.id,
        probe_kind: "sql",
        passed: false,
        evidence: msg.slice(0, 200),
        duration_ms: Date.now() - startedAt,
        skipped_reason: msg,
      };
    }
    return {
      probe_id: probe.id,
      probe_kind: "sql",
      passed: false,
      evidence: msg.slice(0, 200),
      duration_ms: Date.now() - startedAt,
      failure_reason: msg,
    };
  }

  const failures = evaluateExpectations(probe, queryResult);
  const passed = failures.length === 0;
  log.debug(
    {
      probe_id: probe.id,
      driver: resolved.connection.driver,
      rowcount: queryResult.rowcount,
      passed,
      failures: failures.length,
    },
    "sql probe complete",
  );

  return {
    probe_id: probe.id,
    probe_kind: "sql",
    passed,
    evidence: `${resolved.connection.driver}: ${queryResult.rowcount} rows; first=${
      queryResult.rows[0] ? JSON.stringify(queryResult.rows[0]).slice(0, 160) : "(none)"
    }`,
    duration_ms: Date.now() - startedAt,
    ...(passed ? {} : { failure_reason: failures.join("; ") }),
  };
}

function evaluateExpectations(
  probe: SqlProbe,
  result: { rowcount: number; rows: Record<string, unknown>[] },
): string[] {
  const failures: string[] = [];
  const e = probe.expect;
  if (e.rowcount !== undefined && result.rowcount !== e.rowcount) {
    failures.push(`expected rowcount ${e.rowcount}; got ${result.rowcount}`);
  }
  if (e.rowcount_min !== undefined && result.rowcount < e.rowcount_min) {
    failures.push(`expected rowcount >= ${e.rowcount_min}; got ${result.rowcount}`);
  }
  if (e.rowcount_max !== undefined && result.rowcount > e.rowcount_max) {
    failures.push(`expected rowcount <= ${e.rowcount_max}; got ${result.rowcount}`);
  }
  if (e.first_row_includes) {
    const first = result.rows[0];
    if (!first) {
      failures.push("first_row_includes set but result has no rows");
    } else {
      for (const [col, expected] of Object.entries(e.first_row_includes)) {
        const actual = first[col];
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          failures.push(
            `first row column ${col}: expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  }
  return failures;
}
