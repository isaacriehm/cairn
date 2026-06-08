/**
 * Module slicer — partitions a repo into per-module slices for the chunked
 * parallel mapper. Each ModuleSlice is the focused input one Sonnet call sees.
 *
 * Module detection strategy:
 *   - Detect modules via .gitmodules, pnpm/yarn/lerna workspaces, top-level
 *     package.json children, OR top-level dirs with >20 source files.
 *   - Single-package repos collapse to one slice covering the whole repo.
 *   - Each slice carries: directory tree (paths only), package.json (full),
 *     up to 5 representative files (full content), local docs (capped).
 *
 * The mapper-parallel module dispatches one Sonnet call per slice, and the
 * merge call assembles the per-module proposals into a single MapperOutput.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { knownExtensions } from "@isaacriehm/cairn-state";
import { logger } from "../logger.js";

const log = logger("init.module-slicer");

/** Source extensions counted toward module detection — the shared registry. */
const SOURCE_EXTS = new Set<string>(knownExtensions());

const SKIP_DIRS = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "__pycache__",
  "vendor",
  ".venv",
  ".direnv",
  ".cache",
  "coverage",
  ".next",
  ".turbo",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".parcel-cache",
  ".vercel",
  ".netlify",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode",
  ".cairn",
]);

const TOPLEVEL_MODULE_MIN_FILES = 20;
const REPRESENTATIVE_FILE_BUDGET = 5;
const LOCAL_DOCS_CHAR_CAP = 8000;
const REPRESENTATIVE_FILE_CHAR_CAP = 12000;
const DIRECTORY_TREE_LINE_CAP = 800;

/**
 * Per-module thresholds that drive the pre-dispatch split.
 *
 * A monolithic backend module (~400 source files) trips Sonnet's per-call
 * latency / token-budget far past parallel sweet spot, so any module above
 * `LARGE_MODULE_SOURCE_THRESHOLD` is broken into sub-slices on its top-level
 * subdirs. Sub-slices below `SUBSLICE_SOURCE_THRESHOLD` aren't worth a call;
 * we cap at `MAX_SUBSLICES_PER_PARENT` highest-source-count subdirs and let
 * the parent stay if no subdir clears the floor.
 */
const LARGE_MODULE_SOURCE_THRESHOLD = 150;
const SUBSLICE_SOURCE_THRESHOLD = 20;
const MAX_SUBSLICES_PER_PARENT = 6;

export interface ModuleSlice {
  /** Absolute path to the module root. */
  modulePath: string;
  /** Path relative to repoRoot. "." for the whole-repo single-package case. */
  moduleRel: string;
  /** Short slug used in progress display + per-module logs. */
  moduleSlug: string;
  /** Newline-separated relative paths, no file content. */
  directoryTree: string;
  /** Full package.json contents if present at module root, else null. */
  packageJson: string | null;
  /** Up to 5 files with full content (capped). */
  representativeFiles: Array<{ path: string; content: string }>;
  /** Concatenated README/docs, capped. null when no docs found. */
  localDocs: string | null;
}

export interface SliceModulesArgs {
  repoRoot: string;
  /** Optional: cap how many slices to return. Default unlimited. */
  maxSlices?: number;
}

export function sliceModules(args: SliceModulesArgs): ModuleSlice[] {
  const repoRoot = args.repoRoot;
  const detected = detectModuleRoots(repoRoot);
  log.info(
    {
      repo_root: repoRoot,
      detected: detected.length,
      sources: [...new Set(detected.map((d) => d.source))],
    },
    "module roots detected",
  );

  const out: ModuleSlice[] = [];
  if (detected.length === 0) {
    // Single-package: one slice covers the whole repo. Don't split — single-
    // package init is the common case; sub-slicing here would over-fragment.
    const tree = listModuleTree(repoRoot, repoRoot);
    out.push(
      buildSliceFromTree({
        repoRoot,
        moduleAbsPath: repoRoot,
        moduleRel: ".",
        tree,
      }),
    );
  } else {
    for (const d of detected) {
      const tree = listModuleTree(repoRoot, d.absPath);
      const parentSlice = buildSliceFromTree({
        repoRoot,
        moduleAbsPath: d.absPath,
        moduleRel: d.relPath,
        tree,
      });
      const subs = maybeSplitLargeModule({
        parentSlice,
        parentRelPaths: tree.relPaths,
        repoRoot,
      });
      if (subs !== null) {
        log.info(
          {
            parent: parentSlice.moduleSlug,
            parent_files: tree.relPaths.length,
            children: subs.map((s) => s.moduleSlug),
          },
          "large module split into sub-slices",
        );
        out.push(...subs);
      } else {
        out.push(parentSlice);
      }
    }
  }
  if (args.maxSlices !== undefined && out.length > args.maxSlices) {
    return out.slice(0, args.maxSlices);
  }
  return out;
}

/**
 * If `parentSlice` exceeds LARGE_MODULE_SOURCE_THRESHOLD, walk one level
 * deeper into its top-level subdirs and return up to MAX_SUBSLICES_PER_PARENT
 * sub-slices (those with > SUBSLICE_SOURCE_THRESHOLD source files, picked
 * highest-count first). Returns `null` when the module shouldn't or can't
 * be split (under threshold, no subdir clears the floor, or the module's
 * source files all live at module root).
 */
/**
 * Conventional wrappers we transparently descend through when the parent
 * module's source all lives under a single one of these. Without this, a
 * module like `core/{src/auth,src/billing,src/integrations,...}` would split
 * into one sub-slice named `core/src` instead of `core/auth`, `core/billing`,
 * `core/integrations` — useless.
 */
const TRANSPARENT_WRAPPER_DIRS = new Set<string>(["src", "lib", "app", "source"]);
const MAX_TRANSPARENT_DESCENT = 2;

function maybeSplitLargeModule(args: {
  parentSlice: ModuleSlice;
  parentRelPaths: string[];
  repoRoot: string;
}): ModuleSlice[] | null {
  const sourceCount = countSourceFilesInPaths(args.parentRelPaths);
  if (sourceCount <= LARGE_MODULE_SOURCE_THRESHOLD) return null;

  // Walk forward through any transparent wrappers (`src/` etc.) so the split
  // happens at the meaningful directory layer.
  let workingPaths = args.parentRelPaths;
  let wrapperPrefix = "";
  for (let depth = 0; depth < MAX_TRANSPARENT_DESCENT; depth++) {
    const initial = pickSubdirCandidates(workingPaths);
    if (initial.length !== 1) break;
    const onlyCandidate = initial[0];
    if (onlyCandidate === undefined) break;
    const [name] = onlyCandidate;
    if (!TRANSPARENT_WRAPPER_DIRS.has(name)) break;
    workingPaths = workingPaths
      .filter((p) => p === name || p.startsWith(`${name}/`))
      .map((p) => (p.startsWith(`${name}/`) ? p.slice(name.length + 1) : p));
    wrapperPrefix = wrapperPrefix === "" ? name : `${wrapperPrefix}/${name}`;
  }

  // Group source files + all files at the (possibly post-wrapper) layer.
  const sourceCounts = new Map<string, number>();
  const childPathsByDir = new Map<string, string[]>();
  for (const rel of workingPaths) {
    const slash = rel.indexOf("/");
    if (slash < 0) continue; // top-level files of the working layer — stay with parent
    const top = rel.slice(0, slash);
    const remainder = rel.slice(slash + 1);
    if (SOURCE_EXTS.has(extOf(rel))) {
      sourceCounts.set(top, (sourceCounts.get(top) ?? 0) + 1);
    }
    let bucket = childPathsByDir.get(top);
    if (bucket === undefined) {
      bucket = [];
      childPathsByDir.set(top, bucket);
    }
    bucket.push(remainder);
  }

  const candidates = [...sourceCounts.entries()]
    .filter(([, n]) => n >= SUBSLICE_SOURCE_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SUBSLICES_PER_PARENT);
  if (candidates.length === 0) return null;

  const subs: ModuleSlice[] = [];
  for (const [subdir] of candidates) {
    const subRelPaths = (childPathsByDir.get(subdir) ?? []).sort();
    // Filesystem path includes the transparent wrapper (so files are
    // reachable on disk); display slug + moduleRel collapse it for the
    // operator-friendly form ("core/auth", not "core/src/auth").
    const subAbsPath =
      wrapperPrefix === ""
        ? join(args.parentSlice.modulePath, subdir)
        : join(args.parentSlice.modulePath, wrapperPrefix, subdir);
    const subRel =
      args.parentSlice.moduleRel === "."
        ? subdir
        : `${args.parentSlice.moduleRel}/${subdir}`;
    subs.push(
      buildSliceFromTree({
        repoRoot: args.repoRoot,
        moduleAbsPath: subAbsPath,
        moduleRel: subRel,
        tree: { relPaths: subRelPaths, contentCache: new Map() },
        // Sub-slices typically share the parent module's package.json and
        // overarching docs — pass them in as fallbacks. The sub-slice still
        // prefers its own package.json / docs if they exist.
        parentFallbackPackageJson: args.parentSlice.packageJson,
        parentFallbackDocs: args.parentSlice.localDocs,
        // Keep the prefixed slug so progress display / merge see "core/auth"
        // rather than just "auth".
        explicitSlug: subRel,
      }),
    );
  }
  return subs;
}

function pickSubdirCandidates(paths: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const rel of paths) {
    const slash = rel.indexOf("/");
    if (slash < 0) continue;
    if (!SOURCE_EXTS.has(extOf(rel))) continue;
    const top = rel.slice(0, slash);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= SUBSLICE_SOURCE_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);
}

function countSourceFilesInPaths(paths: string[]): number {
  let n = 0;
  for (const p of paths) {
    if (SOURCE_EXTS.has(extOf(p))) n++;
  }
  return n;
}

interface DetectedModule {
  absPath: string;
  relPath: string;
  source: "submodule" | "workspace" | "package-json" | "heuristic";
}

function detectModuleRoots(repoRoot: string): DetectedModule[] {
  const found = new Map<string, DetectedModule>();

  // 1. .gitmodules — every submodule is a hard module boundary.
  for (const path of readGitmodulePaths(repoRoot)) {
    const abs = join(repoRoot, path);
    if (!existsSync(abs)) continue;
    found.set(path, { absPath: abs, relPath: path, source: "submodule" });
  }

  // 2. Workspace configs — pnpm / yarn / lerna.
  for (const path of readWorkspaceMembers(repoRoot)) {
    if (found.has(path)) continue;
    const abs = join(repoRoot, path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    found.set(path, { absPath: abs, relPath: path, source: "workspace" });
  }

  // 3. Top-level dirs with their own package.json.
  for (const path of readTopLevelPackages(repoRoot)) {
    if (found.has(path)) continue;
    const abs = join(repoRoot, path);
    found.set(path, { absPath: abs, relPath: path, source: "package-json" });
  }

  // 4. If still empty, fall back to heuristic — top-level dirs with >20
  // source files become modules.
  if (found.size === 0) {
    for (const path of readHeuristicModules(repoRoot)) {
      const abs = join(repoRoot, path);
      found.set(path, { absPath: abs, relPath: path, source: "heuristic" });
    }
  }

  return [...found.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function readGitmodulePaths(repoRoot: string): string[] {
  const path = join(repoRoot, ".gitmodules");
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*path\s*=\s*(.+)\s*$/);
      if (m && m[1]) out.push(m[1].trim());
    }
    return out;
  } catch {
    return [];
  }
}

function readWorkspaceMembers(repoRoot: string): string[] {
  const out = new Set<string>();
  // pnpm
  const pnpm = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    try {
      const parsed = parseYaml(readFileSync(pnpm, "utf8")) as Record<string, unknown>;
      const pkgs = parsed["packages"];
      if (Array.isArray(pkgs)) {
        for (const glob of pkgs) {
          if (typeof glob !== "string") continue;
          for (const p of expandWorkspaceGlob(repoRoot, glob)) out.add(p);
        }
      }
    } catch {
      // ignore
    }
  }
  // yarn / npm — root package.json `workspaces`
  const rootPkg = join(repoRoot, "package.json");
  if (existsSync(rootPkg)) {
    try {
      const parsed = JSON.parse(readFileSync(rootPkg, "utf8")) as Record<string, unknown>;
      const ws = parsed["workspaces"];
      const globs: string[] = Array.isArray(ws)
        ? ws.filter((s): s is string => typeof s === "string")
        : typeof ws === "object" && ws !== null && Array.isArray((ws as Record<string, unknown>)["packages"])
          ? ((ws as Record<string, unknown>)["packages"] as unknown[]).filter(
              (s): s is string => typeof s === "string",
            )
          : [];
      for (const g of globs) {
        for (const p of expandWorkspaceGlob(repoRoot, g)) out.add(p);
      }
    } catch {
      // ignore
    }
  }
  // lerna
  const lerna = join(repoRoot, "lerna.json");
  if (existsSync(lerna)) {
    try {
      const parsed = JSON.parse(readFileSync(lerna, "utf8")) as Record<string, unknown>;
      const pkgs = parsed["packages"];
      if (Array.isArray(pkgs)) {
        for (const g of pkgs) {
          if (typeof g !== "string") continue;
          for (const p of expandWorkspaceGlob(repoRoot, g)) out.add(p);
        }
      }
    } catch {
      // ignore
    }
  }
  return [...out];
}

/**
 * Expand a workspace glob like `packages/*` or `apps/*` into actual directory
 * paths relative to repoRoot. Supports trailing `/*` and `/**` only —
 * sufficient for every workspace config we've seen in the wild. Returns
 * directories only (not files).
 */
function expandWorkspaceGlob(repoRoot: string, glob: string): string[] {
  const trimmed = glob.replace(/\/(\*\*?|\*)$/, "");
  const isWildcard = glob.endsWith("/*") || glob.endsWith("/**");
  const baseAbs = join(repoRoot, trimmed);
  if (!existsSync(baseAbs)) return [];
  if (!isWildcard) {
    if (statSync(baseAbs).isDirectory()) return [trimmed];
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(baseAbs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(baseAbs, name);
    try {
      if (statSync(abs).isDirectory()) {
        out.push(trimmed === "" ? name : `${trimmed}/${name}`);
      }
    } catch {
      // skip
    }
  }
  return out;
}

function readTopLevelPackages(repoRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(repoRoot, name);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(abs, "package.json"))) out.push(name);
  }
  return out;
}

function readHeuristicModules(repoRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith(".")) continue;
    const abs = join(repoRoot, name);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    if (countSourceFiles(abs) >= TOPLEVEL_MODULE_MIN_FILES) {
      out.push(name);
    }
  }
  return out;
}

function countSourceFiles(dir: string): number {
  let n = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && n < TOPLEVEL_MODULE_MIN_FILES + 1) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(cur, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(abs);
      } else if (s.isFile()) {
        const ext = extOf(name);
        if (SOURCE_EXTS.has(ext)) n++;
      }
    }
  }
  return n;
}

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

interface BuildSliceFromTreeArgs {
  repoRoot: string;
  moduleAbsPath: string;
  moduleRel: string;
  tree: ModuleTreeListing;
  /**
   * Override `moduleSlug`. Used by the splitter so sub-slices keep the
   * "<parent>/<subdir>" prefix (e.g. "core/auth") rather than collapsing to
   * the leaf via `basename`.
   */
  explicitSlug?: string;
  /** Fallback when the sub-slice has no package.json of its own. */
  parentFallbackPackageJson?: string | null;
  /** Fallback when the sub-slice has no module-local docs of its own. */
  parentFallbackDocs?: string | null;
}

function buildSliceFromTree(args: BuildSliceFromTreeArgs): ModuleSlice {
  const moduleAbsPath = args.moduleAbsPath;
  const moduleRel = args.moduleRel;
  const moduleSlug =
    args.explicitSlug !== undefined
      ? args.explicitSlug
      : moduleRel === "."
        ? basename(args.repoRoot) || "root"
        : basename(moduleRel);
  const directoryTree = capLines(args.tree.relPaths, DIRECTORY_TREE_LINE_CAP);
  const ownPackageJson = readIfExists(join(moduleAbsPath, "package.json"));
  const packageJson =
    ownPackageJson !== null
      ? ownPackageJson
      : args.parentFallbackPackageJson ?? null;
  const representativeFiles = pickRepresentativeFiles({
    moduleAbsPath,
    moduleRel,
    relPaths: args.tree.relPaths,
    contentByPath: args.tree.contentCache,
  });
  const ownDocs = readLocalDocs(moduleAbsPath, args.tree.relPaths);
  const localDocs = ownDocs !== null ? ownDocs : args.parentFallbackDocs ?? null;
  return {
    modulePath: moduleAbsPath,
    moduleRel,
    moduleSlug,
    directoryTree,
    packageJson,
    representativeFiles,
    localDocs,
  };
}

interface ModuleTreeListing {
  /** Paths relative to the module root (POSIX slashes). */
  relPaths: string[];
  /**
   * Pre-loaded text content for files we'll likely want for the
   * representative-file pass — controllers, services, schemas, routers.
   * Saves a second readFileSync per candidate.
   */
  contentCache: Map<string, string>;
}

function listModuleTree(repoRoot: string, moduleAbsPath: string): ModuleTreeListing {
  // Try git ls-files filtered to the module path first; falls back to FS walk.
  const fromGit = tryGitLsModule(repoRoot, moduleAbsPath);
  if (fromGit !== null) {
    return { relPaths: fromGit.sort(), contentCache: new Map() };
  }
  const out: string[] = [];
  const stack: string[] = [moduleAbsPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(cur, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(abs);
      } else if (s.isFile()) {
        out.push(relative(moduleAbsPath, abs).split("\\").join("/"));
      }
    }
  }
  return { relPaths: out.sort(), contentCache: new Map() };
}

function tryGitLsModule(repoRoot: string, moduleAbsPath: string): string[] | null {
  const isRoot = moduleAbsPath === repoRoot;
  // Submodules are their own git worktree — ls-files from the submodule itself.
  const cwdForGit = moduleAbsPath;
  if (!existsSync(join(cwdForGit, ".git"))) {
    // Not a git worktree. If we're inside the parent repo, we can still ls
    // the module subset by prefix-filtering.
    if (!isRoot && existsSync(join(repoRoot, ".git"))) {
      try {
        const out = execFileSync(
          "git",
          [
            "-C",
            repoRoot,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            relative(repoRoot, moduleAbsPath),
          ],
          { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 },
        );
        const prefix = relative(repoRoot, moduleAbsPath) + "/";
        return out
          .toString("utf8")
          .split("\0")
          .filter((s) => s.length > 0)
          .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    const out = execFileSync(
      "git",
      [
        "-C",
        cwdForGit,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 },
    );
    return out
      .toString("utf8")
      .split("\0")
      .filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

function capLines(lines: string[], cap: number): string {
  if (lines.length <= cap) return lines.join("\n");
  const head = lines.slice(0, cap);
  return [...head, `… (${lines.length - cap} more files truncated)`].join("\n");
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

interface PickRepresentativeArgs {
  moduleAbsPath: string;
  moduleRel: string;
  relPaths: string[];
  contentByPath: Map<string, string>;
}

function pickRepresentativeFiles(
  args: PickRepresentativeArgs,
): Array<{ path: string; content: string }> {
  const picked = new Map<string, string>();
  const tryAdd = (rel: string): boolean => {
    if (picked.size >= REPRESENTATIVE_FILE_BUDGET) return true;
    if (picked.has(rel)) return false;
    const abs = join(args.moduleAbsPath, rel);
    let content = args.contentByPath.get(rel);
    if (content === undefined) {
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        return false;
      }
      args.contentByPath.set(rel, content);
    }
    if (content.length > REPRESENTATIVE_FILE_CHAR_CAP) {
      content =
        content.slice(0, REPRESENTATIVE_FILE_CHAR_CAP) +
        `\n… (truncated; original ${content.length} chars)\n`;
    }
    picked.set(rel, content);
    return picked.size >= REPRESENTATIVE_FILE_BUDGET;
  };

  // 1. Module-root entry points.
  for (const candidate of ["index.ts", "index.tsx", "main.ts", "app.ts"]) {
    if (args.relPaths.includes(candidate)) {
      if (tryAdd(candidate)) return [...picked].map(([path, content]) => ({ path, content }));
    }
  }

  // 2. Largest *.controller.ts / *.service.ts by line count.
  const ctrlServiceCandidates = args.relPaths.filter(
    (p) => /\.(controller|service)\.(ts|tsx|js)$/i.test(p),
  );
  if (ctrlServiceCandidates.length > 0) {
    let best: { path: string; lines: number } | null = null;
    for (const cand of ctrlServiceCandidates) {
      const abs = join(args.moduleAbsPath, cand);
      try {
        const text = readFileSync(abs, "utf8");
        args.contentByPath.set(cand, text);
        const lines = text.split("\n").length;
        if (best === null || lines > best.lines) best = { path: cand, lines };
      } catch {
        // skip unreadable
      }
    }
    if (best !== null) {
      if (tryAdd(best.path)) return [...picked].map(([path, content]) => ({ path, content }));
    }
  }

  // 3. Schema roots — drizzle, prisma, mongoose-style models.
  for (const cand of args.relPaths) {
    if (
      /(^|\/)(prisma\/schema\.prisma|src\/db\/schema\.ts|db\/schema\.ts|schema\.ts|models\/index\.ts)$/i.test(
        cand,
      )
    ) {
      if (tryAdd(cand)) return [...picked].map(([path, content]) => ({ path, content }));
    }
  }

  // 4. Most-imported file (approximate via grep for relative imports).
  const mostImported = approximateMostImported({
    moduleAbsPath: args.moduleAbsPath,
    relPaths: args.relPaths,
  });
  if (mostImported !== null) {
    if (tryAdd(mostImported)) return [...picked].map(([path, content]) => ({ path, content }));
  }

  // 5. Router-style entry points.
  for (const cand of args.relPaths) {
    if (/(^|\/)(router|routes|api)\.(ts|tsx|js)$/i.test(cand)) {
      if (tryAdd(cand)) return [...picked].map(([path, content]) => ({ path, content }));
    }
  }

  return [...picked].map(([path, content]) => ({ path, content }));
}

function approximateMostImported(args: {
  moduleAbsPath: string;
  relPaths: string[];
}): string | null {
  const sourceFiles = args.relPaths.filter(
    (p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p),
  );
  if (sourceFiles.length === 0) return null;
  const counts = new Map<string, number>();
  // Scan up to 200 source files for `from "./..."` or `from "../..."`.
  // Each found relative-import target gets counted.
  const scanCap = Math.min(sourceFiles.length, 200);
  for (let i = 0; i < scanCap; i++) {
    const rel = sourceFiles[i];
    if (rel === undefined) continue;
    const abs = join(args.moduleAbsPath, rel);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const importRe = /from\s+["'](\.{1,2}\/[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text)) !== null) {
      const target = m[1];
      if (target === undefined) continue;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  // Resolve top target back to a relPath that exists in the module.
  const sorted = [...counts.entries()].sort(([, a], [, b]) => b - a);
  for (const [target] of sorted) {
    // crude: strip leading ./ or ../, drop extension if present, look for a
    // matching relPath suffix
    const stripped = target.replace(/^\.+\//, "").replace(/\.\w+$/, "");
    const candidates = args.relPaths.filter((p) =>
      p.replace(/\.\w+$/, "").endsWith(stripped),
    );
    if (candidates.length > 0 && candidates[0] !== undefined) return candidates[0];
  }
  return null;
}

function readLocalDocs(moduleAbsPath: string, relPaths: string[]): string | null {
  const docPaths: string[] = [];
  for (const rel of relPaths) {
    if (
      /^README(\.[a-z]+)?$/i.test(rel) ||
      /^AGENTS\.md$/i.test(rel) ||
      /^CLAUDE\.md$/i.test(rel) ||
      /^docs\/[^/]+\.(md|mdx)$/i.test(rel)
    ) {
      docPaths.push(rel);
    }
  }
  if (docPaths.length === 0) return null;
  const parts: string[] = [];
  let total = 0;
  for (const rel of docPaths.sort()) {
    const abs = join(moduleAbsPath, rel);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const block = `### ${rel}\n${content}`;
    if (total + block.length > LOCAL_DOCS_CHAR_CAP) {
      const room = Math.max(0, LOCAL_DOCS_CHAR_CAP - total);
      if (room > 0) parts.push(block.slice(0, room) + "\n… (truncated)");
      break;
    }
    parts.push(block);
    total += block.length + 2;
  }
  return parts.join("\n\n");
}

