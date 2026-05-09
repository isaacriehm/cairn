#!/usr/bin/env tsx
/**
 * smoke-doc-claims — GC pass 10 (doc-claims-vs-runtime) acceptance.
 *
 * Synthetic mini-repo with a runtime that disagrees with the prose
 * surface in known ways. The pass should:
 *
 *   1. Read the runtime: 5 packages, 3-entry smoke chain, 2 MCP tools,
 *      4 hook events.
 *   2. Flag every prose claim that contradicts the runtime — and only
 *      those. Section-marker headings ("§3 Package contents") and
 *      idiomatic singular prose ("one package would force ...") must
 *      NOT trip the regex.
 *   3. Honor `runtimeOverride` for tests that want to pin the truth.
 *   4. Emit zero findings when prose matches the runtime.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDocClaimsVsRuntime } from "@isaacriehm/cairn-core";

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

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-doc-claims-"));
  cleanups.push(root);

  const seedPackages = ["cairn", "cairn-core", "cairn-state", "cairn-frontend-claudecode", "cairn-lens"] as const;
  for (const name of seedPackages) {
    const dir = resolve(root, "packages", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@test/${name}` }, null, 2));
  }

  const smokesChain = "pnpm smoke:foo && pnpm smoke:bar && pnpm smoke:baz";
  writeFileSync(
    resolve(root, "packages", "cairn", "package.json"),
    JSON.stringify({ name: "@test/cairn", scripts: { smokes: smokesChain } }, null, 2),
  );

  const mcpDir = resolve(root, "packages", "cairn-core", "src", "mcp", "tools");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(
    join(mcpDir, "index.ts"),
    `export const allTools = [\n  fooTool,\n  barTool,\n];\n`,
  );

  const hooksDir = resolve(root, "packages", "cairn-frontend-claudecode", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [], Stop: [], UserPromptSubmit: [], PostToolUse: [] } }, null, 2),
  );

  return root;
}

const STALE_README = `
# Test Project

Plus four runtime layers that keep those stores live: an MCP server (25 typed tools).

- 21-smoke gate. all green on a clean tree.
- four-package boundary
- manifest + 6 hooks (SessionStart, Stop, UserPromptSubmit)

## §3 Package contents

Bundling them into one package would force every adopter.
`;

const CLEAN_README = `
# Test Project

Plus four runtime layers that keep those stores live: an MCP server (2 typed tools).

- 3-smoke gate. all green on a clean tree.
- five-package boundary
- manifest + 4 hooks (SessionStart, Stop, UserPromptSubmit, PostToolUse)

## §3 Package contents

Bundling them into one package would force every adopter.
`;

async function main(): Promise<void> {
  console.log("smoke-doc-claims — start");

  const repo = makeRepo();

  header("Step 1 — runtime detection");
  {
    writeFileSync(join(repo, "README.md"), CLEAN_README, "utf8");
    const r = runDocClaimsVsRuntime({ repoRoot: repo });
    if (r.runtime.packageCount !== 5) fail(`packageCount expected 5, got ${r.runtime.packageCount}`);
    if (r.runtime.smokeCount !== 3) fail(`smokeCount expected 3, got ${r.runtime.smokeCount}`);
    if (r.runtime.mcpToolCount !== 2) fail(`mcpToolCount expected 2, got ${r.runtime.mcpToolCount}`);
    if (r.runtime.hookEventCount !== 4) fail(`hookEventCount expected 4, got ${r.runtime.hookEventCount}`);
    pass("runtime: packages=5, smokes=3, mcp=2, hooks=4");
  }

  header("Step 2 — clean prose emits zero findings (no false positives on §3 Package, 'one package')");
  {
    const r = runDocClaimsVsRuntime({ repoRoot: repo });
    if (r.findings.length !== 0) {
      console.error(JSON.stringify(r.findings, null, 2));
      fail(`expected 0 findings, got ${r.findings.length}`);
    }
    pass("clean prose → no findings");
  }

  header("Step 3 — drifted prose flags every claim against runtime");
  {
    writeFileSync(join(repo, "README.md"), STALE_README, "utf8");
    const r = runDocClaimsVsRuntime({ repoRoot: repo });
    const kindsHit = new Set(
      r.findings
        .map((f) => /claims (\w+)=/i.exec(f.detail)?.[1])
        .filter((x): x is string => typeof x === "string"),
    );
    for (const expected of ["packageCount", "smokeCount", "mcpToolCount", "hookEventCount"]) {
      if (!kindsHit.has(expected)) {
        console.error(JSON.stringify(r.findings, null, 2));
        fail(`expected finding for ${expected}, got ${[...kindsHit].join(",")}`);
      }
    }
    if (r.findings.some((f) => /one package/.test(f.matched_text ?? ""))) {
      fail("'one package' singular prose was flagged — false positive");
    }
    if (r.findings.some((f) => /§3 Package/.test(f.matched_text ?? ""))) {
      fail("'§3 Package contents' heading was flagged — false positive");
    }
    pass("4 distinct kinds flagged, no false positives");
  }

  header("Step 4 — runtimeOverride pins truth for tests");
  {
    const r = runDocClaimsVsRuntime({
      repoRoot: repo,
      runtimeOverride: { packageCount: 4, smokeCount: 21, mcpToolCount: 25, hookEventCount: 6 },
    });
    if (r.runtime.packageCount !== 4) fail("override did not pin packageCount");
    if (r.findings.length !== 0) {
      console.error(JSON.stringify(r.findings, null, 2));
      fail("override aligned with stale prose → expected 0 findings");
    }
    pass("override pins runtime, prose now matches → 0 findings");
  }

  header("Step 5 — every finding carries pass id + path + line + matched_text");
  {
    writeFileSync(join(repo, "README.md"), STALE_README, "utf8");
    const r = runDocClaimsVsRuntime({ repoRoot: repo });
    for (const f of r.findings) {
      if (f.pass !== "doc-claims-vs-runtime") fail(`bad pass id: ${f.pass}`);
      if (f.kind !== "doc_claim_drift") fail(`bad kind: ${f.kind}`);
      if (typeof f.path !== "string" || f.path.length === 0) fail("missing path");
      if (typeof f.line !== "number" || f.line <= 0) fail("missing line");
      if (typeof f.matched_text !== "string" || f.matched_text.length === 0) fail("missing matched_text");
      if (f.severity !== "warn") fail(`bad severity: ${f.severity}`);
    }
    pass(`${r.findings.length} findings, all well-shaped`);
  }

  header("Step 6 — sweep wires the pass through (zero findings on a clean repo, pass duration recorded)");
  {
    writeFileSync(join(repo, "README.md"), CLEAN_README, "utf8");
    const { runGcSweep } = await import("@isaacriehm/cairn-core");
    const sweep = await runGcSweep({ repoRoot: repo });
    if (sweep.pass_durations["doc-claims-vs-runtime"] === undefined) {
      fail("sweep did not record doc-claims-vs-runtime pass");
    }
    const claimFindings = sweep.findings.filter((f) => f.pass === "doc-claims-vs-runtime");
    if (claimFindings.length !== 0) {
      console.error(JSON.stringify(claimFindings, null, 2));
      fail(`sweep emitted ${claimFindings.length} doc-claim findings on clean repo`);
    }
    pass("sweep wired; clean repo → 0 doc-claim findings");
  }

  console.log("smoke-doc-claims — pass");
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
