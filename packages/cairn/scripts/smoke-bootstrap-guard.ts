#!/usr/bin/env tsx
/**
 * smoke-bootstrap-guard — Layer 4 degraded mode.
 *
 * Verifies:
 *   - requireBootstrap returns null on non-git dirs (no false positive)
 *   - requireBootstrap returns null when .cairn/config.yaml is absent
 *   - requireBootstrap returns null when core.hooksPath is set
 *   - requireBootstrap returns BOOTSTRAP_REQUIRED envelope when adopted clone
 *     is unbootstrapped
 *   - MCP write tools (resolve_attention) honor the guard
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
  isMcpError,
  type McpContext,
  type ToolDef,
  requireBootstrap,
  runJoin,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-guard-"));
  cleanups.push(dir);
  return dir;
}

function gitInit(repoRoot: string): void {
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repoRoot });
}

async function call<T = unknown>(
  tool: ToolDef<T>,
  ctx: McpContext,
  input: T,
): Promise<unknown> {
  return tool.handler(ctx, input);
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  step("Step 1 — non-git dir passes through guard");
  const noGit = mkdir();
  mkdirSync(join(noGit, ".cairn"), { recursive: true });
  writeFileSync(
    join(noGit, ".cairn", "config.yaml"),
    "version: 1\ncairn_version: 0.0.0\nslug: x\n",
    "utf8",
  );
  const r1 = requireBootstrap(noGit);
  assert(r1 === null, "non-git dir not blocked");
  console.log("  ✓ Step 1 — non-git dir passes");

  step("Step 2 — .git but no config.yaml passes through");
  const noConfig = mkdir();
  gitInit(noConfig);
  mkdirSync(join(noConfig, ".cairn"), { recursive: true });
  const r2 = requireBootstrap(noConfig);
  assert(r2 === null, "missing config.yaml not blocked");
  console.log("  ✓ Step 2 — no config.yaml passes");

  step("Step 3 — adopted clone without core.hooksPath blocks");
  const blocked = mkdir();
  gitInit(blocked);
  mkdirSync(join(blocked, ".cairn"), { recursive: true });
  writeFileSync(
    join(blocked, ".cairn", "config.yaml"),
    "version: 1\ncairn_version: 0.0.0\nslug: x\n",
    "utf8",
  );
  const r3 = requireBootstrap(blocked);
  assert(r3 !== null, "adopted clone blocks");
  assert(isMcpError(r3), "blocked result is mcpError");
  if (isMcpError(r3)) {
    assert(r3.error.code === "BOOTSTRAP_REQUIRED", "code = BOOTSTRAP_REQUIRED");
    assert(r3.error.message.includes("cairn join"), "message cites cairn join");
  }
  console.log("  ✓ Step 3 — adopted clone blocked");

  step("Step 4 — after runJoin sets hooksPath, guard passes");
  // runJoin will fail because git-hooks dir is missing — seed minimal one.
  mkdirSync(join(blocked, ".cairn", "git-hooks"), { recursive: true });
  writeFileSync(
    join(blocked, ".cairn", "git-hooks", "pre-commit"),
    "#!/usr/bin/env bash\nexit 0\n",
    "utf8",
  );
  const join1 = runJoin({ cwd: blocked });
  assert(join1.bootstrapped === true, "join bootstrapped");
  const r4 = requireBootstrap(blocked);
  assert(r4 === null, "after join, guard passes");
  console.log("  ✓ Step 4 — guard passes after join");

  step("Step 5 — resolve_attention returns BOOTSTRAP_REQUIRED on unbootstrapped clone");
  const tool = (allTools as ToolDef<unknown>[]).find(
    (t) => t.name === "cairn_resolve_attention",
  );
  assert(tool !== undefined, "resolve_attention registered");
  const repoRoot2 = mkdir();
  gitInit(repoRoot2);
  mkdirSync(join(repoRoot2, ".cairn"), { recursive: true });
  writeFileSync(
    join(repoRoot2, ".cairn", "config.yaml"),
    "version: 1\ncairn_version: 0.0.0\nslug: x\n",
    "utf8",
  );
  const ctx: McpContext = { repoRoot: repoRoot2, sessionId: "smoke" };
  const result = (await call(tool!, ctx, {
    item_id: "DEC-a3f7b2c",
    choice: "a",
    kind: "decision_draft",
  })) as Record<string, unknown>;
  assert(isMcpError(result), "tool returned mcpError envelope");
  if (isMcpError(result)) {
    assert(
      result.error.code === "BOOTSTRAP_REQUIRED",
      `expected BOOTSTRAP_REQUIRED, got ${result.error.code}`,
    );
  }
  console.log("  ✓ Step 5 — resolve_attention blocks on unbootstrapped clone");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-bootstrap-guard — pass");
}

main().catch((err) => {
  console.error("smoke-bootstrap-guard — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
