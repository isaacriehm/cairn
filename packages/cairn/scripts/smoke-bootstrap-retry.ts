#!/usr/bin/env tsx
/**
 * smoke-bootstrap-retry — bootstrap-retry MCP tool acceptance.
 *
 *   1. `cairn_bootstrap_retry` registered in allTools with the right description.
 *   2. Adopted clone with hooks dir present → handler returns ok=true,
 *      bootstrapped=true, set-hooks-path step ok.
 *   3. Tool is idempotent — second run still returns ok=true.
 *   4. Adopted clone WITHOUT hooks dir → handler returns ok=false +
 *      error=BOOTSTRAP_FAILED + non-empty failed_steps citing the missing dir.
 *   5. Handler does NOT loop through requireBootstrap (verified by
 *      construction: a missing-hooks repo would otherwise reject before
 *      runJoin, but the handler reports runJoin's per-step detail).
 *   6. After a successful retry, `requireBootstrap` returns null on the
 *      same repoRoot — confirming downstream write-tools no longer block.
 *   7. The bootstrap-guard remediation never references the CLI bundle
 *      path (`cli.mjs`) — surface contract for plugin spec §11.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
  isMcpError,
  requireBootstrap,
  type McpContext,
  type ToolDef,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-bootstrap-retry-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(
    join(dir, ".cairn", "config.yaml"),
    "version: 1\ncairn_version: 0.0.0\nslug: smoke\n",
    "utf8",
  );
  return dir;
}

function seedHooksDir(repo: string): void {
  const hooksDir = join(repo, ".cairn", "git-hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, "pre-commit"),
    "#!/usr/bin/env bash\nexit 0\n",
    "utf8",
  );
}

function findTool(name: string): ToolDef<unknown> {
  const tool = (allTools as ToolDef<unknown>[]).find((t) => t.name === name);
  if (tool === undefined) fail(`tool ${name} not registered in allTools`);
  return tool;
}

function ctxFor(repo: string): McpContext {
  return { repoRoot: repo, sessionId: "smoke" };
}

interface OkResult {
  ok: true;
  bootstrapped: true;
  repo_root: string;
  cli_version: string;
  steps: { step: string; status: string; detail: string }[];
}

interface FailResult {
  ok: false;
  error: string;
  bootstrapped: false;
  repo_root: string | null;
  steps: { step: string; status: string; detail: string }[];
  failed_steps: string[];
}

async function main(): Promise<void> {
  console.log("smoke-bootstrap-retry — start");

  header("Step 1 — cairn_bootstrap_retry registered with correct description");
  {
    const tool = findTool("cairn_bootstrap_retry");
    if (!tool.description.toLowerCase().includes("bootstrap")) {
      fail(`description should mention bootstrap; got: ${tool.description}`);
    }
    if (!tool.description.toLowerCase().includes("idempotent")) {
      fail(`description should advertise idempotency; got: ${tool.description}`);
    }
    pass("registered + description shape");
  }

  header("Step 2 — adopted clone with hooks → ok=true, bootstrapped=true");
  {
    const repo = mkRepo();
    seedHooksDir(repo);
    const tool = findTool("cairn_bootstrap_retry");
    const result = (await tool.handler(ctxFor(repo), {})) as OkResult | FailResult;
    if (!result.ok) fail(`expected ok=true, got ${JSON.stringify(result)}`);
    if (result.bootstrapped !== true) fail("expected bootstrapped=true");
    if (result.repo_root !== repo) fail(`repo_root mismatch: ${result.repo_root}`);
    const setHooks = result.steps.find((s) => s.step === "set-hooks-path");
    if (setHooks?.status !== "ok") fail(`set-hooks-path step should be ok, got ${JSON.stringify(setHooks)}`);
    pass("bootstrap retry succeeded on a seeded clone");
  }

  header("Step 3 — idempotent: second call still ok");
  {
    const repo = mkRepo();
    seedHooksDir(repo);
    const tool = findTool("cairn_bootstrap_retry");
    const r1 = (await tool.handler(ctxFor(repo), {})) as OkResult;
    if (!r1.ok) fail("first call should succeed");
    const r2 = (await tool.handler(ctxFor(repo), {})) as OkResult;
    if (!r2.ok) fail("second call should also succeed (idempotent)");
    pass("two successive calls return ok=true");
  }

  header("Step 4 — missing hooks dir → ok=false + failed_steps non-empty");
  {
    const repo = mkRepo();
    // intentionally do NOT seed hooks dir
    const tool = findTool("cairn_bootstrap_retry");
    const result = (await tool.handler(ctxFor(repo), {})) as OkResult | FailResult;
    if (result.ok !== false) fail(`expected ok=false, got ${JSON.stringify(result)}`);
    if (result.error !== "BOOTSTRAP_FAILED") {
      fail(`expected error=BOOTSTRAP_FAILED, got ${result.error}`);
    }
    if (result.failed_steps.length === 0) fail("failed_steps should be non-empty");
    const cite = result.failed_steps.find((s) => s.includes("set-hooks-path"));
    if (cite === undefined) {
      fail(`failed_steps should cite set-hooks-path, got ${JSON.stringify(result.failed_steps)}`);
    }
    pass(`ok=false with failed_steps: ${cite}`);
  }

  header("Step 5 — after successful retry, requireBootstrap returns null");
  {
    const repo = mkRepo();
    seedHooksDir(repo);
    const tool = findTool("cairn_bootstrap_retry");
    const before = requireBootstrap(repo);
    // before may be null if runJoin auto-fired inside requireBootstrap and
    // succeeded — that's fine, we just need to confirm AFTER the explicit
    // retry the guard still passes.
    const result = (await tool.handler(ctxFor(repo), {})) as OkResult;
    if (!result.ok) fail(`retry should succeed; got ${JSON.stringify(result)}`);
    const after = requireBootstrap(repo);
    if (after !== null) fail(`expected guard null after retry, got ${JSON.stringify(after)}`);
    void before;
    pass("guard passes after explicit retry");
  }

  header("Step 6 — bootstrap-guard remediation does NOT expose CLI bundle path");
  {
    // Create a clone that bootstrap-guard's auto-join will fail on, so we
    // can capture the BOOTSTRAP_REQUIRED envelope and inspect remediation.
    const repo = mkRepo();
    // No hooks dir → join will fail with set-hooks-path error.
    const blocked = requireBootstrap(repo);
    if (blocked === null) fail("expected guard to block on un-bootstrapped clone");
    if (!isMcpError(blocked)) fail("blocked result must be McpError envelope");
    const details = (blocked as { error: { details?: Record<string, unknown> } }).error
      .details;
    const remediation = details?.["remediation"];
    if (typeof remediation !== "string") fail("remediation must be a string");
    if (remediation.includes("cli.mjs")) {
      fail(`remediation must not reference cli.mjs (plugin spec §11); got: ${remediation}`);
    }
    if (remediation.includes("CLAUDE_PLUGIN_ROOT")) {
      fail(`remediation must not expose CLAUDE_PLUGIN_ROOT path; got: ${remediation}`);
    }
    if (!remediation.includes("cairn_bootstrap_retry")) {
      fail(`remediation should advertise the cairn_bootstrap_retry tool; got: ${remediation}`);
    }
    pass("remediation cites cairn_bootstrap_retry MCP tool, no CLI subcommand exposure");
  }

  console.log("\nsmoke-bootstrap-retry — pass");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
