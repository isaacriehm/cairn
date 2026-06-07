/**
 * Deterministic component-dir detection for adoption (Phase 4-seed).
 *
 * No LLM. Probes conventional component directories that actually
 * exist on disk and proposes a `components:` block for
 * `.cairn/config.yaml`. Returns `null` when the project has no
 * recognizable component layout (non-UI repos stay untouched).
 *
 * Isolation invariant (port invariant 3): a monorepo workspace is
 * NEVER guessed as `shared`. We omit the flag entirely — it normalizes
 * to isolated — and leave the opt-in to the operator (manual config
 * edit or the future annotate step).
 */

import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_EXCLUDE,
  DEFAULT_EXTENSIONS,
  walkFs,
  type ComponentsConfig,
} from "@isaacriehm/cairn-state";
import type { DetectionResult } from "./types.js";

/** Conventional component-dir suffixes, probed in order under a root or package. */
const CONVENTIONAL_DIRS = [
  "src/components",
  "src/features",
  "app/components",
  "src/app/components",
  "components",
] as const;

/** Monorepo package parents to scan for nested component dirs. */
const MONOREPO_PARENTS = ["packages", "apps"] as const;

/** Extensions we sniff for beyond the React default. */
const SVELTE_EXT = ".svelte";
const VUE_EXT = ".vue";

/**
 * Detect the extension set to scan. Defaults to the React profile
 * (`.tsx`/`.jsx`); appends `.vue`/`.svelte` only when such files
 * actually exist under the candidate dirs (framework-agnostic, but
 * presence-driven so we never invent extensions a repo doesn't use).
 */
function detectExtensions(repoRoot: string, dirs: string[]): string[] {
  let hasVue = false;
  let hasSvelte = false;
  let hasReact = false;
  const skipDirs = new Set<string>([...DEFAULT_EXCLUDE]);
  for (const dir of dirs) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    walkFs({
      dir: abs,
      repoRoot,
      skipDirs,
      onFile: (_rel, fileAbs) => {
        const e = extname(fileAbs);
        if (e === VUE_EXT) hasVue = true;
        else if (e === SVELTE_EXT) hasSvelte = true;
        else if (e === ".tsx" || e === ".jsx") hasReact = true;
      },
    });
  }
  const exts: string[] = [];
  // Keep the React pair as the baseline unless the repo is purely
  // Vue/Svelte — most TS UI repos still carry .tsx alongside framework files.
  if (hasReact || (!hasVue && !hasSvelte)) exts.push(...DEFAULT_EXTENSIONS);
  if (hasVue) exts.push(VUE_EXT);
  if (hasSvelte) exts.push(SVELTE_EXT);
  return exts;
}

/** Conventional dirs (relative to `base`) that exist on disk. */
function existingDirs(repoRoot: string, base: string): string[] {
  return CONVENTIONAL_DIRS.map((suffix) =>
    base.length > 0 ? `${base}/${suffix}` : suffix,
  ).filter((rel) => existsSync(join(repoRoot, rel)));
}

interface WorkspaceProbe {
  name: string;
  dirs: string[];
}

/** Scan `packages/*` + `apps/*` for sub-packages with component dirs. */
function probeMonorepo(repoRoot: string): WorkspaceProbe[] {
  const exclude = new Set<string>([...DEFAULT_EXCLUDE]);
  const found: WorkspaceProbe[] = [];
  const usedNames = new Set<string>();
  for (const parent of MONOREPO_PARENTS) {
    const parentAbs = join(repoRoot, parent);
    if (!existsSync(parentAbs)) continue;
    let subs: import("node:fs").Dirent[];
    try {
      subs = readdirSync(parentAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of subs.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory() || exclude.has(d.name) || d.name.startsWith(".")) {
        continue;
      }
      const dirs = existingDirs(repoRoot, `${parent}/${d.name}`);
      if (dirs.length === 0) continue;
      // Disambiguate a name shared by packages/<x> and apps/<x>.
      let name = d.name;
      if (usedNames.has(name)) name = `${parent}-${d.name}`;
      usedNames.add(name);
      found.push({ name, dirs });
    }
  }
  return found;
}

/**
 * Probe `repoRoot` for a component layout and return a `components:`
 * config block (raw yaml shape), or `null` when nothing is found.
 *
 * - 2+ monorepo packages with component dirs → `workspaces` form.
 * - Exactly one package, or root-level dirs → flat single-app form.
 *
 * `detection` is reserved for future stack-aware tuning; extension
 * detection is presence-driven so the result holds even when stack
 * signatures are absent (e.g. a Vue repo with no tsconfig).
 */
export function detectComponentsConfig(
  repoRoot: string,
  _detection: DetectionResult,
): ComponentsConfig | null {
  const workspaces = probeMonorepo(repoRoot);

  if (workspaces.length >= 2) {
    const allDirs = workspaces.flatMap((w) => w.dirs);
    const config: ComponentsConfig = {
      extensions: detectExtensions(repoRoot, allDirs),
      categories: [...DEFAULT_CATEGORIES],
      exclude: [...DEFAULT_EXCLUDE],
      workspaces: Object.fromEntries(
        workspaces.map((w) => [w.name, { componentDirs: w.dirs }]),
      ),
    };
    return config;
  }

  // Single-app: a lone monorepo package's dirs, else root-level dirs.
  const dirs =
    workspaces.length === 1
      ? workspaces[0]!.dirs
      : existingDirs(repoRoot, "");
  if (dirs.length === 0) return null;

  return {
    componentDirs: dirs,
    extensions: detectExtensions(repoRoot, dirs),
    categories: [...DEFAULT_CATEGORIES],
    exclude: [...DEFAULT_EXCLUDE],
  };
}
