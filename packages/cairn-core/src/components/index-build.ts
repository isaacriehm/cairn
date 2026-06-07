/**
 * Component index builder — collect `@cairn` headers and write the derived
 * inventory to `.cairn/ground/components/`.
 *
 * Single-app → one flat INDEX.md. Monorepo → INDEX.md manifest +
 * index/<ws>.md slices, with orphan slices (renamed/removed workspaces)
 * cleaned up. The written tree is derived + gitignored (D3); the committed
 * source of truth is the `@cairn` headers in code.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  collectComponents,
  componentsGroundDir,
  componentsSliceDir,
  loadComponentsConfig,
  renderComponentsIndex,
} from "@isaacriehm/cairn-state";

export interface ComponentIndexBuildResult {
  /** Relative paths written under .cairn/ground/components/. */
  written: string[];
  /** Orphan slice paths removed. */
  orphansRemoved: string[];
  /** Components indexed. */
  total: number;
  /** Files missing a header. */
  missing: number;
  workspaces: number;
  /** Approximate token cost of the largest single artifact to load. */
  tokensApprox: number;
}

export function buildComponentIndex(repoRoot: string): ComponentIndexBuildResult {
  const config = loadComponentsConfig(repoRoot);
  const { components, missing } = collectComponents(repoRoot, config);
  const files = renderComponentsIndex(components, config);

  const groundDir = componentsGroundDir(repoRoot);
  const written: string[] = [];
  let tokensApprox = 0;
  for (const [rel, content] of files) {
    const out = join(groundDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content, "utf8");
    written.push(rel);
    tokensApprox = Math.max(tokensApprox, Math.round(content.length / 4));
  }

  const orphansRemoved: string[] = [];
  const sliceDir = componentsSliceDir(repoRoot);
  if (existsSync(sliceDir)) {
    for (const f of readdirSync(sliceDir)) {
      const rel = `index/${f}`;
      if (f.endsWith(".md") && !files.has(rel)) {
        rmSync(join(sliceDir, f));
        orphansRemoved.push(rel);
      }
    }
  }

  return {
    written,
    orphansRemoved,
    total: components.length,
    missing: missing.length,
    workspaces: config.workspaces.length,
    tokensApprox,
  };
}
