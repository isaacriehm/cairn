#!/usr/bin/env tsx
/**
 * smoke-e2e-adoption — full adoption pipeline against a fresh fixture.
 *
 * Spec: PLUGIN_ARCHITECTURE §6 + §17. Step 9 of the build sequence.
 *
 * Builds a synthetic git repo with rationale-bearing source comments,
 * existing CLAUDE.md/AGENTS.md rule sections, an operator keep block,
 * and a Node `package.json`. Runs `runInit` in auto mode with mocked
 * classifiers (no Haiku spend), then asserts every Phase 4/6/7b/7c/12
 * artifact landed correctly.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  KEEP_END_MARKER,
  KEEP_START_MARKER,
  inspectJoinState,
  runInit,
  runJoin,
  type CommentBlock,
  type CommentClassification,
  type RuleClassification,
  type RuleSection,
  type RuleSourceFile,
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

function step(label: string): void {
  console.log(`── ${label}`);
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

async function main(): Promise<void> {
  step("Build synthetic fixture");
  const repoRoot = mkdtempSync(join(tmpdir(), "cairn-smoke-e2e-adopt-"));
  cleanups.push(repoRoot);

  // Initialize a real git repo so Phase 12 + bypass detection mechanics work.
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repoRoot });

  // Node project surface so Phase 12 patches `prepare`.
  writeFile(
    repoRoot,
    "package.json",
    JSON.stringify(
      {
        name: "fixture",
        version: "0.0.0",
        scripts: { test: "echo ok", prepare: "husky install" },
      },
      null,
      2,
    ) + "\n",
  );

  // TS file with rationale-bearing JSDoc + license header + short comment.
  writeFile(
    repoRoot,
    "src/auth.ts",
    [
      "/**",
      " * Copyright 2026 Acme.",
      " * Licensed under MIT.",
      " * SPDX-License-Identifier: MIT",
      " */",
      "",
      "/**",
      " * We sign JWTs with HS512 because deployment topology lacks key rotation",
      " * and the 15-minute TTL keeps replay risk low. Revisit when KMS arrives;",
      " * see thread for the original rationale and constraints driving this.",
      " * @returns string",
      " */",
      "export function sign(): string {",
      "  return 'jwt';",
      "}",
      "",
      "// short non-essay comment",
      "export function verify(): boolean { return true; }",
    ].join("\n") + "\n",
  );

  // CLAUDE.md with H2 sections + operator keep block.
  writeFile(
    repoRoot,
    "CLAUDE.md",
    [
      "# Project rules",
      "",
      "## Brand voice",
      "",
      "Always write in active voice. Avoid filler. Lead with the answer.",
      "",
      "## Architecture overview",
      "",
      "TOC pointing at docs/.",
      "",
      KEEP_START_MARKER,
      "Operator hand-written ops note — never overwrite this paragraph.",
      KEEP_END_MARKER,
      "",
    ].join("\n"),
  );

  writeFile(
    repoRoot,
    "AGENTS.md",
    "# Agents\n\n## Locations\n\nSee docs/.\n",
  );

  // Seed initial commit so SHA-based machinery works downstream.
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

  console.log(`  fixture at ${repoRoot}`);

  step("Run runInit with mocks (auto mode + Phase 7b/7c/12)");
  let phase7bDecCount = 0;
  let phase7cNetNewCount = 0;
  const result = await runInit({
    repoRoot,
    mode: "auto",
    autoProceed: "a",
    autoE2e: "defer",
    skipBrandSetup: true,
    skipSubmoduleCheck: true,
    skipMonorepoGuard: true,
    skipSelfAdoptionGuard: true,
    skipMapper: true,
    skipGuidedSetup: true,
    // Force ingestion path on (auto mode normally skips it).
    skipIngestion: false,
    // Phase 7b: any rationale-shaped block gets marked rationale.
    mockSourceCommentClassify: (block: CommentBlock): CommentClassification => {
      if (block.kind === "license") {
        return { blockId: block.id, kind: "license", failed: false };
      }
      // Treat the JWT JSDoc as rationale.
      if (/HS512|JWT/i.test(block.prose)) {
        phase7bDecCount += 1;
        return { blockId: block.id, kind: "rationale", failed: false };
      }
      return { blockId: block.id, kind: "other", failed: false };
    },
    // Phase 7c: "Brand voice" section becomes a net-new rule.
    mockRulesMergeClassify: (
      section: RuleSection,
      source: RuleSourceFile,
    ): RuleClassification => {
      if (section.title === "Brand voice") {
        phase7cNetNewCount += 1;
        return {
          source: source.path,
          level: section.level,
          title: section.title,
          startOffset: section.startOffset,
          kind: "rule-net-new",
          proposedDecTitle: "Always write in active voice",
          proposedRationale: "Active voice keeps copy direct.",
          conflictsWith: "",
          failed: false,
        };
      }
      return {
        source: source.path,
        level: section.level,
        title: section.title,
        startOffset: section.startOffset,
        kind: "informational",
        proposedDecTitle: "",
        proposedRationale: "",
        conflictsWith: "",
        failed: false,
      };
    },
  });

  assert(result.proceed === true, "init proceeded");
  assert(result.seeded_files.length > 0, "files seeded");

  step("Step 1 — .cairn/ skeleton landed");
  for (const p of [
    ".cairn/config.yaml",
    ".cairn/config/workflow.md",
    ".cairn/config/sensors.yaml",
    ".cairn/ground/manifest.yaml",
    ".cairn/git-hooks/pre-commit",
    ".cairn/git-hooks/post-commit",
    ".cairn/git-hooks/commit-msg",
    ".cairn/JOIN.md",
    ".github/workflows/cairn-check.yml",
  ]) {
    assert(existsSync(join(repoRoot, p)), `expected file ${p}`);
  }
  console.log("  ✓ Step 1 — full template + multi-dev artifacts seeded");

  step("Step 2 — config.yaml carries cairn_version");
  const config = parseYaml(
    readFileSync(join(repoRoot, ".cairn", "config.yaml"), "utf8"),
  ) as Record<string, unknown>;
  assert(typeof config["cairn_version"] === "string", "cairn_version present");
  console.log(`  ✓ Step 2 — cairn_version=${String(config["cairn_version"])}`);

  step("Step 3 — Phase 7b: source-comments audit + DECs written");
  assert(result.source_comments !== null, "source_comments result populated");
  assert(
    result.source_comments!.decsWritten.length === phase7bDecCount,
    `expected ${phase7bDecCount} DECs from source-comments, got ${result.source_comments!.decsWritten.length}`,
  );
  assert(
    existsSync(join(repoRoot, result.source_comments!.auditRelPath)),
    "source-comments audit yaml exists",
  );
  // License block was kept but never strip-replaced.
  const licCount = result.source_comments!.kindCounts["license"];
  assert(licCount >= 1, "license header captured");
  console.log(
    `  ✓ Step 3 — ${result.source_comments!.decsWritten.length} DEC(s); audit at ${result.source_comments!.auditRelPath}`,
  );

  step("Step 4 — Phase 7c: rules-merge audit + DEC drafts written");
  assert(result.rules_merge !== null, "rules_merge result populated");
  assert(
    result.rules_merge!.kindCounts["rule-net-new"] === phase7cNetNewCount,
    `expected ${phase7cNetNewCount} rule-net-new`,
  );
  assert(
    result.rules_merge!.decDraftsWritten.length === phase7cNetNewCount,
    "rule-net-new DEC drafts persisted",
  );
  assert(
    existsSync(join(repoRoot, result.rules_merge!.auditRelPath)),
    "rules-merge audit yaml exists",
  );
  // Operator keep section auto-classified without going through Haiku.
  assert(
    result.rules_merge!.kindCounts["operator-keep"] >= 1,
    "operator-keep section auto-tagged",
  );
  console.log(
    `  ✓ Step 4 — ${result.rules_merge!.decDraftsWritten.length} DEC draft(s); operator-keep ${result.rules_merge!.kindCounts["operator-keep"]}`,
  );

  step("Step 5 — Phase 7b DEC body landed in ground state");
  const decDir = join(repoRoot, ".cairn/ground/decisions");
  const firstDecId = result.source_comments!.decsWritten[0]?.id;
  assert(typeof firstDecId === "string", "phase 7b emitted at least one DEC");
  const decBody = readFileSync(join(decDir, `${firstDecId}.md`), "utf8");
  assert(decBody.includes("HS512"), "source-comment DEC body cites HS512");
  assert(decBody.includes("status: accepted"), "phase 7b DEC auto-promoted to accepted");
  assert(decBody.includes("sot_kind: ledger"), "sot_kind=ledger");
  console.log("  ✓ Step 5 — DECs accepted + bodies wired");

  step("Step 6 — Phase 12 multi-dev detection (no auto-prepare)");
  assert(result.multi_dev !== null, "multi_dev result populated");
  assert(
    result.multi_dev!.hostKinds.includes("node-package-json"),
    "node host detected",
  );
  // v0.2.0+: phase 12 no longer auto-patches package.json. The Claude
  // Code SessionStart bootstrap banner owns per-clone bootstrap; auto-
  // wiring `cairn join || true` into prepare failed noisily for plugin
  // users without a global cairn binary.
  assert(
    result.multi_dev!.preparePatched === false,
    "phase 12 must not auto-patch prepare (plugin owns bootstrap)",
  );
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { scripts: { prepare?: string; test?: string } };
  assert(
    pkg.scripts.prepare === "husky install",
    "existing prepare untouched (no cairn-join injection)",
  );
  assert(
    result.multi_dev!.manualHints.some((h) =>
      h.includes("SessionStart bootstrap banner"),
    ),
    "manual hint cites SessionStart bootstrap path",
  );
  console.log("  ✓ Step 6 — package.json untouched, hint surfaces SessionStart path");

  step("Step 7 — git hooks executable + .attested-commits gitignored");
  for (const hook of ["pre-commit", "post-commit", "commit-msg"]) {
    const abs = join(repoRoot, ".cairn/git-hooks", hook);
    const mode = statSync(abs).mode;
    assert((mode & 0o100) !== 0, `${hook} owner-executable`);
  }
  const gitignore = readFileSync(join(repoRoot, ".cairn/.gitignore"), "utf8");
  assert(gitignore.includes(".attested-commits"), "attested-commits gitignored");
  console.log("  ✓ Step 7 — hooks 0755 + .attested-commits gitignored");

  step("Step 8 — adopted clone is unbootstrapped → cairn join works");
  // Pre-bootstrap: inspectJoinState reports hooks NOT set.
  const pre = inspectJoinState({ repoRoot });
  assert(pre.hooksPathSet === false, "hooks not yet set pre-join");
  // Run join.
  const joined = runJoin({ cwd: repoRoot });
  assert(joined.bootstrapped === true, "join bootstrapped");
  const post = inspectJoinState({ repoRoot });
  assert(post.hooksPathSet === true, "hooks set after join");
  assert(post.versionMatches === true, "cairn_version matches CLI VERSION");
  console.log("  ✓ Step 8 — cairn join successful + state consistent");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-e2e-adoption — pass");
}

main().catch((err) => {
  console.error("smoke-e2e-adoption — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
