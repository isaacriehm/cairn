/**
 * cli probe — spawns a child process and asserts on exit_code/stdout/stderr.
 *
 * For ACs that assert CLI behavior. No shell, no globbing — `command` and
 * `args` are passed directly to spawn so injection isn't a concern unless
 * the agent literally puts a shell-redirect into args.
 */

import { spawn } from "node:child_process";
import { logger } from "../../logger.js";
import type { CliProbe, ProbeRunResult } from "../types.js";

const log = logger("uat.probe.cli");

export async function runCliProbe(args: {
  probe: CliProbe;
}): Promise<ProbeRunResult> {
  const startedAt = Date.now();
  const probe = args.probe;

  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), probe.timeout_ms ?? 30_000);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(probe.command, probe.args, {
      cwd: probe.cwd,
      env: probe.env ? { ...process.env, ...probe.env } : process.env,
      signal: ctrl.signal,
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const msg = String(err);
      if (/aborted/i.test(msg)) timedOut = true;
      stderr += `\n[spawn-error] ${msg}`;
      resolve({ exitCode: -1, stdout, stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });

  const failures = evaluateExpectations({
    probe,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  });

  const passed = failures.length === 0;
  log.debug(
    {
      probe_id: probe.id,
      command: probe.command,
      exit_code: result.exitCode,
      passed,
      failures: failures.length,
    },
    "cli probe complete",
  );

  return {
    probe_id: probe.id,
    probe_kind: "cli",
    passed,
    evidence: `${probe.command} ${probe.args.join(" ")} → exit=${result.exitCode}; stdout[0..200]=${result.stdout.slice(0, 200)}`,
    duration_ms: Date.now() - startedAt,
    ...(passed ? {} : { failure_reason: failures.join("; ") }),
  };
}

function evaluateExpectations(args: {
  probe: CliProbe;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): string[] {
  const failures: string[] = [];
  const e = args.probe.expect;

  if (args.timedOut) {
    failures.push(`timed out after ${args.probe.timeout_ms ?? 30_000}ms`);
  }
  if (e.exit_code !== undefined && args.exitCode !== e.exit_code) {
    failures.push(`expected exit_code ${e.exit_code}; got ${args.exitCode}`);
  }
  if (e.stdout_contains !== undefined) {
    for (const needle of e.stdout_contains) {
      if (!args.stdout.includes(needle)) {
        failures.push(`stdout missing expected substring: ${needle.slice(0, 60)}`);
      }
    }
  }
  if (e.stdout_matches_regex !== undefined) {
    try {
      const re = new RegExp(e.stdout_matches_regex);
      if (!re.test(args.stdout)) {
        failures.push(`stdout did not match /${e.stdout_matches_regex}/`);
      }
    } catch {
      failures.push(`stdout_matches_regex unparseable: /${e.stdout_matches_regex}/`);
    }
  }
  if (e.stderr_empty === true && args.stderr.trim().length > 0) {
    failures.push(`expected stderr empty; got ${args.stderr.length} bytes`);
  }
  if (e.stderr_contains !== undefined) {
    for (const needle of e.stderr_contains) {
      if (!args.stderr.includes(needle)) {
        failures.push(`stderr missing expected substring: ${needle.slice(0, 60)}`);
      }
    }
  }
  return failures;
}
