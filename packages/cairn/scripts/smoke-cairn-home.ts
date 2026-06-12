#!/usr/bin/env tsx
/**
 * smoke-cairn-home — the centralization grep-gate.
 *
 * Ghost mode relocates Cairn state out of the client repo by routing every
 * path through `cairnHome(repoRoot)` / `cairnDir(repoRoot, …)` (cairn-state
 * `home.ts`). The out-of-repo guarantee only holds if NO call site rebuilds
 * `<repoRoot>/.cairn/…` directly. A single missed literal writes a stray
 * `.cairn/` into the client tree and breaks the zero-footprint promise.
 *
 * This gate fails the build if any `join(<x>, ".cairn", …)` literal — or any
 * global `homedir() … ".cairn"` construction — survives outside the two
 * sanctioned files (`home.ts`, `paths.ts`) and the handful of repo-root
 * discovery probes (which look for the *physical* in-repo marker on purpose
 * and are tagged with a `discovery probe` comment).
 *
 * A second gate (below) pins the `isGhost` ghost-mode forks to a documented
 * allowlist of selection points, so ghost branches cannot scatter into new
 * files unnoticed. See the `ISGHOST_ALLOW` header for the file-level scope of
 * that guarantee.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:cairn-home
 *
 * Scope: `.cairn` path centralization + the ghost selection-point gate (#2).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/** Source trees that must route through cairnHome. */
const SCAN_ROOTS = [
  "packages/cairn-state/src",
  "packages/cairn-core/src",
  "packages/cairn/src",
];

/** Files allowed to construct the literal `.cairn` path (the resolver itself). */
const ALLOW_FILES = new Set(["home.ts", "paths.ts"]);

/** Leak: `join(<single-arg>, ".cairn"` — the in-repo absolute construction. */
const LEAK_RE = /\bjoin\(\s*[^,()]+,\s*["']\.cairn["']/;
/** Global-home literal that should go through `userCairnRoot()`. */
const GLOBAL_RE = /homedir\(\)[^;]*["']\.cairn["']/;

/**
 * Ghost selection-point gate (#2, grep-gate half).
 *
 * Ghost mode is configuration on one code path: every fork gates on
 * `isGhost(repoRoot)` (cairn-state `home.ts`). The branches are narrow and
 * cohesive per-vertical today; the risk is *scatter* — a future edit sprouting
 * a ghost branch in some unrelated file, re-creating the "two environments
 * drift" the strategy interfaces were meant to prevent. Rather than refactor
 * the working, tested branches behind interfaces (large, risky, no new
 * behavior), this gate pins `isGhost` to a documented allowlist of the existing
 * selection points and fails the build on any NEW file that references it.
 *
 * Scope of the guarantee: file-level. A new ghost VERTICAL (= a new file) is
 * blocked; adding a branch inside an already-listed file is NOT. That is the
 * deliberate "half" — it buys the no-future-scatter guard without touching a
 * byte of the locked committed path. Grow this list consciously: a new entry
 * is a decision to put ghost logic somewhere new.
 *
 * Scope: the ghost selection-point gate (#2).
 */
const ISGHOST_SCAN_ROOTS = [
  "packages/cairn-state/src",
  "packages/cairn-core/src",
  "packages/cairn/src",
  "packages/cairn-lens/src",
];
const ISGHOST_RE = /\bisGhost\b/;
/** Documented selection points — the only files allowed to branch on ghost. */
const ISGHOST_ALLOW = new Set([
  // resolver / binding (where ghost is decided + state is keyed)
  "packages/cairn-state/src/home.ts", // isGhost definition
  "packages/cairn-state/src/scope-index.ts",
  "packages/cairn-state/src/components.ts",
  "packages/cairn-state/src/paths.ts", // hooks-path + adoption-marker mode fork
  // onboarding (init / seed / session-start) — join routes through paths.ts now
  "packages/cairn-core/src/init/init.ts",
  "packages/cairn-core/src/init/seed.ts",
  "packages/cairn-core/src/session-start/build.ts",
  // marker projection (source-comment strip + claude-rule + sot-align)
  "packages/cairn-core/src/init/claude-rule.ts",
  "packages/cairn-core/src/init/source-comments/strip-replace.ts",
  "packages/cairn-core/src/hooks/post-tool-use/sot-align.ts",
  // component registry (freshness / reconfirm / emit / register / annotate)
  "packages/cairn-core/src/components/freshness.ts",
  "packages/cairn-core/src/components/reconfirm.ts",
  "packages/cairn-core/src/components/emit.ts",
  "packages/cairn-core/src/mcp/tools/component-register.ts",
  "packages/cairn-core/src/mcp/tools/component-annotate.ts",
  "packages/cairn-core/src/mcp/tools/component-reconfirm.ts",
  "packages/cairn-core/src/init/phases/9e-comp-annotate.ts",
  // enforcement (multi-dev / record-decision / gc anchor + orphan / backup / hot write)
  "packages/cairn-core/src/init/multi-dev/install.ts",
  "packages/cairn-core/src/mcp/tools/record-decision.ts",
  "packages/cairn-core/src/gc/ghost-anchor.ts",
  "packages/cairn-core/src/gc/entity-orphan.ts",
  "packages/cairn-core/src/hooks/ghost-backup.ts",
  "packages/cairn-core/src/hooks/post-tool-use/post-write.ts",
  // lens (out-of-repo resolution + the ghost render fork) — the providers route
  // through resolver.governedBlocksForFile, so they no longer branch on isGhost
  "packages/cairn-lens/src/resolver.ts",
  "packages/cairn-lens/src/extension.ts",
]);

interface Finding {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "dist" || e.name === "node_modules" || e.name === "templates") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts")) {
      out.push(p);
    }
  }
}

const findings: Finding[] = [];
const files: string[] = [];
for (const root of SCAN_ROOTS) {
  const abs = resolve(repoRoot, root);
  try {
    if (statSync(abs).isDirectory()) walk(abs, files);
  } catch {
    /* tree may be absent in a partial checkout — skip */
  }
}

for (const file of files) {
  if (ALLOW_FILES.has(basename(file))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!LEAK_RE.test(line) && !GLOBAL_RE.test(line)) continue;
    // Allowlist: repo-root discovery probes (physical in-repo marker lookup),
    // tagged with a `discovery probe` comment within the 2 preceding lines.
    const ctx = `${lines[i - 3] ?? ""}\n${lines[i - 2] ?? ""}\n${lines[i - 1] ?? ""}`;
    if (/discovery probe/i.test(ctx)) continue;
    findings.push({
      file: file.replace(`${repoRoot}/`, ""),
      line: i + 1,
      text: line.trim(),
    });
  }
}

// --- Gate 2: ghost selection points ----------------------------------------
const ghostFiles: string[] = [];
for (const root of ISGHOST_SCAN_ROOTS) {
  const abs = resolve(repoRoot, root);
  try {
    if (statSync(abs).isDirectory()) walk(abs, ghostFiles);
  } catch {
    /* tree may be absent in a partial checkout — skip */
  }
}

const ghostFindings: Finding[] = [];
for (const file of ghostFiles) {
  const rel = file.replace(`${repoRoot}/`, "");
  if (ISGHOST_ALLOW.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!ISGHOST_RE.test(lines[i]!)) continue;
    ghostFindings.push({ file: rel, line: i + 1, text: lines[i]!.trim() });
    break; // one finding per file is enough to fail + locate it
  }
}

let failed = false;

if (findings.length > 0) {
  failed = true;
  console.error(
    `✗ smoke-cairn-home: ${findings.length} un-centralized .cairn path literal(s) — route through cairnDir/cairnHome (or tag a discovery probe):\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}\n    ${f.text}`);
  }
}

if (ghostFindings.length > 0) {
  failed = true;
  console.error(
    `✗ smoke-cairn-home: ${ghostFindings.length} ghost branch(es) in file(s) outside the documented selection-point allowlist — keep ghost logic in the existing verticals, or add the file to ISGHOST_ALLOW deliberately (see header):\n`,
  );
  for (const f of ghostFindings) {
    console.error(`  ${f.file}:${f.line}\n    ${f.text}`);
  }
}

if (failed) process.exit(1);

console.log(
  `✓ smoke-cairn-home: ${files.length} files scanned, all .cairn paths route through cairnHome; ` +
    `${ghostFiles.length} files scanned, isGhost confined to ${ISGHOST_ALLOW.size} documented selection points`,
);
