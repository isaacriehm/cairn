#!/usr/bin/env tsx
/**
 * smoke-config-drift — the Stage 1 config-drift GC pass (0.28.0).
 *
 * Drives `runConfigDrift` against a fixture whose declared config has drifted
 * from the tree in four ways, asserts each finding kind fires exactly once,
 * that a clean repo is silent, that resolving the config clears every finding,
 * and that `writeConfigDriftBaseline` persists the sensor-audit-shaped payload
 * the cairn-attention surface reads. Fixtures use neutral placeholder names.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runConfigDrift, writeConfigDriftBaseline } from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const p of cleanups.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-smoke-cfgdrift-${tag}-`));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  return dir;
}

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function kinds(findings: { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
}

const DRIFTED_CONFIG = [
  "version: 1",
  "slug: smoke",
  "off_limits:",
  "  - node_modules/",
  "  - dist/",
  "components:",
  "  workspaces:",
  "    app:",
  "      componentDirs:",
  "        - src/components",
  "        - src/gone", // declared but never created → orphan
  "      extensions:",
  "        - .tsx",
  "      categories:",
  "        - forms",
  "",
].join("\n");

function main(): void {
  console.log("smoke-config-drift — start");

  // ── Drifted fixture — all four kinds fire ───────────────────────────
  const repo = mkRepo("drift");
  write(repo, ".cairn/config.yaml", DRIFTED_CONFIG);
  // .gitignore ignores build/ which off_limits doesn't cover (node_modules/ +
  // dist/ ARE covered → not flagged).
  write(repo, ".gitignore", "node_modules/\ndist/\nbuild/\n");
  // Covered component (under componentDir, configured ext).
  write(repo, "src/components/Button.tsx", "export const Button = () => null;\n");
  // Uncovered ext: .vue under a componentDir, not in `extensions`.
  write(repo, "src/components/Modal.vue", "<template></template>\n");
  // Uncovered dir: 3 component-typed files outside every componentDir.
  write(repo, "src/widgets/A.tsx", "export const A = () => null;\n");
  write(repo, "src/widgets/B.tsx", "export const B = () => null;\n");
  write(repo, "src/widgets/C.tsx", "export const C = () => null;\n");

  const r1 = runConfigDrift({ repoRoot: repo });
  const c1 = kinds(r1.findings);
  assert(c1["config_orphan_path"] === 1, "orphan: declared componentDir that vanished fires once");
  assert(
    r1.findings.some((f) => f.kind === "config_orphan_path" && f.path === "src/gone"),
    "orphan: names the missing componentDir",
  );
  assert(c1["config_gitignore_drift"] === 1, "gitignore-drift: uncovered .gitignore entry fires once");
  assert(
    r1.findings.some((f) => f.kind === "config_gitignore_drift" && f.path === "build/"),
    "gitignore-drift: flags build/ (node_modules/ + dist/ are covered)",
  );
  assert(c1["config_uncovered_dir"] === 1, "uncovered-dir: grown dir fires once");
  assert(
    r1.findings.some((f) => f.kind === "config_uncovered_dir" && f.path === "src/widgets"),
    "uncovered-dir: names src/widgets",
  );
  assert(c1["config_uncovered_ext"] === 1, "uncovered-ext: .vue under componentDir fires once");
  assert(
    r1.findings.some((f) => f.kind === "config_uncovered_ext" && f.detail.includes(".vue")),
    "uncovered-ext: names the .vue extension",
  );
  assert(r1.findings.length === 4, "exactly four findings, no cross-trigger");
  console.log("  ✓ all four finding kinds fire exactly once on a drifted repo");

  // ── Baseline persistence — sensor-audit-shaped, hard severity ───────
  const baseline = writeConfigDriftBaseline(repo, r1.findings, "2026-06-13T00:00:00.000Z");
  assert(baseline.path !== null && baseline.total === 4, "baseline written with 4 findings");
  const payload = parseYaml(
    readFileSync(join(repo, ".cairn/baseline/config-drift-2026-06-13T00-00-00-000Z.yaml"), "utf8"),
  ) as { total_findings: number; sensors: { sensor_id: string; findings: { severity: string }[] }[] };
  assert(payload.total_findings === 4, "baseline total_findings === 4");
  assert(payload.sensors[0]?.sensor_id === "config-drift", "baseline sensor_id is config-drift");
  assert(
    payload.sensors[0]?.findings.every((f) => f.severity === "hard"),
    "baseline findings are hard (counted toward attention_count)",
  );
  console.log("  ✓ baseline persisted in sensor-audit shape (hard findings)");

  // ── Clean repo — silent ─────────────────────────────────────────────
  const clean = mkRepo("clean");
  write(
    clean,
    ".cairn/config.yaml",
    [
      "version: 1",
      "slug: smoke",
      "off_limits:",
      "  - node_modules/",
      "components:",
      "  workspaces:",
      "    app:",
      "      componentDirs:",
      "        - src/components",
      "      extensions:",
      "        - .tsx",
      "",
    ].join("\n"),
  );
  write(clean, ".gitignore", "node_modules/\n");
  write(clean, "src/components/Button.tsx", "export const Button = () => null;\n");
  const rc = runConfigDrift({ repoRoot: clean });
  assert(rc.findings.length === 0, "clean repo produces no findings");
  const emptyBaseline = writeConfigDriftBaseline(clean, rc.findings);
  assert(emptyBaseline.path === null && emptyBaseline.total === 0, "no baseline written when clean");
  console.log("  ✓ clean repo is silent; no baseline written");

  // ── Resolution — fix the config, re-run → every finding clears ──────
  write(
    repo,
    ".cairn/config.yaml",
    [
      "version: 1",
      "slug: smoke",
      "off_limits:",
      "  - node_modules/",
      "  - dist/",
      "  - build/", // covers the gitignore entry
      "components:",
      "  workspaces:",
      "    app:",
      "      componentDirs:",
      "        - src/components",
      "        - src/widgets", // covers the grown dir
      "      extensions:",
      "        - .tsx",
      "        - .vue", // covers the uncovered ext
      "      categories:",
      "        - forms",
      "",
    ].join("\n"),
  );
  const r2 = runConfigDrift({ repoRoot: repo });
  assert(r2.findings.length === 0, "resolving the config clears every finding (no re-flag)");
  console.log("  ✓ config fixes clear all findings — no re-flag after resolution");

  cleanup();
  console.log("smoke-config-drift — pass");
}

main();
