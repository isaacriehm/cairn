/**
 * Integration probe — docker-compose orchestration.
 *
 * Pipeline:
 *   1. `docker compose -f <file> up -d <service>` (or up -d if service unset)
 *   2. Poll ready_check (http or cli) until pass or 60s timeout
 *   3. Run nested test probe (http or cli)
 *   4. `docker compose -f <file> down` (always — even on failure)
 *
 * Skips when `docker compose` not on PATH OR compose_file doesn't exist.
 * Operator runs `harness setup:uat-docker` to provision the compose template
 * and confirm docker availability.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { logger } from "../../logger.js";
import type { IntegrationProbe, ProbeRunResult } from "../types.js";
import { runCliProbe } from "./cli.js";
import { runHttpProbe } from "./http.js";

const log = logger("uat.probe.integration");

function dockerComposeAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["compose", "--version"], { encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function spawnPromise(args: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 120_000);
    let stdout = "";
    let stderr = "";
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
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
      resolve({ exitCode: -1, stdout, stderr: stderr + `\n[spawn-error] ${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

async function pollReadyCheck(
  ready: IntegrationProbe["ready_check"],
  deadline: number,
): Promise<{ ok: boolean; reason?: string }> {
  while (Date.now() < deadline) {
    if (ready.kind === "http") {
      try {
        const res = await fetch(ready.url, {
          signal: AbortSignal.timeout(ready.timeout_ms ?? 5_000),
        });
        if (ready.status === undefined) {
          if (res.status >= 200 && res.status < 500) return { ok: true };
        } else if (res.status === ready.status) {
          return { ok: true };
        }
      } catch {
        // Service not ready yet — continue polling.
      }
    } else {
      const out = await spawnPromise({
        command: ready.command,
        args: ready.args,
        timeoutMs: ready.timeout_ms ?? 5_000,
      });
      if (out.exitCode === 0) return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { ok: false, reason: `ready_check timed out` };
}

export async function runIntegrationProbe(args: {
  probe: IntegrationProbe;
  repoRoot?: string;
}): Promise<ProbeRunResult> {
  const startedAt = Date.now();
  const probe = args.probe;

  if (!dockerComposeAvailable()) {
    return {
      probe_id: probe.id,
      probe_kind: "integration",
      passed: false,
      evidence: "docker compose not on PATH",
      duration_ms: Date.now() - startedAt,
      skipped_reason:
        "docker compose missing — install Docker Desktop or run `harness setup:uat-docker`",
    };
  }

  const composeFile = isAbsolute(probe.compose_file)
    ? probe.compose_file
    : join(args.repoRoot ?? process.cwd(), probe.compose_file);
  if (!existsSync(composeFile)) {
    return {
      probe_id: probe.id,
      probe_kind: "integration",
      passed: false,
      evidence: `compose file not found: ${composeFile}`,
      duration_ms: Date.now() - startedAt,
      skipped_reason: `compose file ${composeFile} missing — provision via setup:uat-docker`,
    };
  }

  // ── Up ───────────────────────────────────────────────────────────────
  const up = await spawnPromise({
    command: "docker",
    args: ["compose", "-f", composeFile, "up", "-d", probe.service],
    timeoutMs: 120_000,
  });
  if (up.exitCode !== 0) {
    await teardown(composeFile);
    return {
      probe_id: probe.id,
      probe_kind: "integration",
      passed: false,
      evidence: `docker compose up exit=${up.exitCode}; stderr=${up.stderr.slice(0, 200)}`,
      duration_ms: Date.now() - startedAt,
      failure_reason: `docker compose up failed: ${up.stderr.slice(0, 400)}`,
    };
  }
  log.info({ probe_id: probe.id, service: probe.service }, "compose up succeeded");

  // ── Ready check ──────────────────────────────────────────────────────
  const readyDeadline = Date.now() + 60_000;
  const ready = await pollReadyCheck(probe.ready_check, readyDeadline);
  if (!ready.ok) {
    await teardown(composeFile);
    return {
      probe_id: probe.id,
      probe_kind: "integration",
      passed: false,
      evidence: `ready_check failed; service ${probe.service} did not come up`,
      duration_ms: Date.now() - startedAt,
      failure_reason: ready.reason ?? "ready_check failed",
    };
  }
  log.info({ probe_id: probe.id }, "ready_check passed");

  // ── Nested test probe ────────────────────────────────────────────────
  let testResult: ProbeRunResult;
  if (probe.test.kind === "http") {
    testResult = await runHttpProbe({ probe: probe.test });
  } else if (probe.test.kind === "cli") {
    testResult = await runCliProbe({ probe: probe.test });
  } else {
    await teardown(composeFile);
    return {
      probe_id: probe.id,
      probe_kind: "integration",
      passed: false,
      evidence: `nested test probe must be http or cli, got ${(probe.test as { kind: string }).kind}`,
      duration_ms: Date.now() - startedAt,
      failure_reason: "integration probes only nest http/cli probes",
    };
  }

  await teardown(composeFile);

  return {
    probe_id: probe.id,
    probe_kind: "integration",
    passed: testResult.passed,
    evidence: `compose ${probe.service} up; test=${testResult.evidence.slice(0, 160)}`,
    duration_ms: Date.now() - startedAt,
    ...(testResult.failure_reason !== undefined ? { failure_reason: testResult.failure_reason } : {}),
  };
}

async function teardown(composeFile: string): Promise<void> {
  try {
    await spawnPromise({
      command: "docker",
      args: ["compose", "-f", composeFile, "down"],
      timeoutMs: 60_000,
    });
  } catch {
    // best effort — don't mask the test result
  }
}
