/**
 * http probe — bare fetch.
 *
 * Verifies network endpoint behavior without spinning up a browser. The
 * cheapest UAT probe; preferred for any AC that asserts status / body /
 * shape / headers.
 */

import { logger } from "../../logger.js";
import type { HttpProbe, ProbeRunResult } from "../types.js";

const log = logger("uat.probe.http");

export async function runHttpProbe(args: {
  probe: HttpProbe;
  baseUrl?: string;
}): Promise<ProbeRunResult> {
  const startedAt = Date.now();
  const url = resolveUrl(args.probe.request.url, args.baseUrl);
  const init: RequestInit = {
    method: args.probe.request.method,
    signal: AbortSignal.timeout(args.probe.timeout_ms ?? 30_000),
    ...(args.probe.request.headers !== undefined ? { headers: args.probe.request.headers } : {}),
    ...(args.probe.request.body !== undefined ? { body: args.probe.request.body } : {}),
  };

  let response: Response;
  let body: string;
  try {
    response = await fetch(url, init);
    body = await response.text();
  } catch (err) {
    return {
      probe_id: args.probe.id,
      probe_kind: "http",
      passed: false,
      evidence: `fetch failed: ${String(err).slice(0, 200)}`,
      duration_ms: Date.now() - startedAt,
      failure_reason: `fetch threw: ${String(err)}`,
    };
  }

  const failures = evaluateExpectations({
    probe: args.probe,
    response,
    body,
  });

  const passed = failures.length === 0;
  log.debug(
    {
      probe_id: args.probe.id,
      url,
      status: response.status,
      passed,
      failures: failures.length,
    },
    "http probe complete",
  );

  return {
    probe_id: args.probe.id,
    probe_kind: "http",
    passed,
    evidence: `${args.probe.request.method} ${url} → ${response.status}; body[0..200]=${body.slice(0, 200)}`,
    duration_ms: Date.now() - startedAt,
    ...(passed ? {} : { failure_reason: failures.join("; ") }),
  };
}

function resolveUrl(target: string, baseUrl?: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  if (baseUrl === undefined) return target;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedTarget = target.startsWith("/") ? target : `/${target}`;
  return `${trimmedBase}${trimmedTarget}`;
}

function evaluateExpectations(args: {
  probe: HttpProbe;
  response: Response;
  body: string;
}): string[] {
  const failures: string[] = [];
  const e = args.probe.expect;

  if (e.status !== undefined && args.response.status !== e.status) {
    failures.push(`expected status ${e.status}; got ${args.response.status}`);
  }
  if (e.status_in !== undefined && !e.status_in.includes(args.response.status)) {
    failures.push(
      `expected status ∈ {${e.status_in.join(", ")}}; got ${args.response.status}`,
    );
  }
  if (e.body_contains !== undefined) {
    for (const needle of e.body_contains) {
      if (!args.body.includes(needle)) {
        failures.push(`body missing expected substring: ${needle.slice(0, 60)}`);
      }
    }
  }
  if (e.body_matches_regex !== undefined) {
    try {
      const re = new RegExp(e.body_matches_regex);
      if (!re.test(args.body)) {
        failures.push(`body did not match /${e.body_matches_regex}/`);
      }
    } catch {
      failures.push(`body_matches_regex unparseable: /${e.body_matches_regex}/`);
    }
  }
  if (e.json_path_equals !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.body);
    } catch {
      failures.push("response body is not JSON");
      return failures;
    }
    for (const { path, value } of e.json_path_equals) {
      const actual = jsonPathGet(parsed, path);
      const expected = JSON.stringify(value);
      const got = JSON.stringify(actual);
      if (expected !== got) {
        failures.push(`json path ${path}: expected ${expected}; got ${got}`);
      }
    }
  }
  if (e.header_present !== undefined) {
    for (const name of e.header_present) {
      if (args.response.headers.get(name) === null) {
        failures.push(`expected header ${name} not present`);
      }
    }
  }
  return failures;
}

/**
 * Minimal JSON-path getter. Supports dot + bracket notation:
 *   "data.users[0].id", "rows[0].name". No wildcards, no slicing.
 */
function jsonPathGet(value: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cursor: unknown = value;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
