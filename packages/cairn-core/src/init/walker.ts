/**
 * Repo walker — produces a structural inventory the init mapper consumes.
 *
 * Walks the adopted project's working tree at adoption time, respecting
 * `.gitignore` (via `git ls-files --cached --others --exclude-standard`
 * when a git repo is present) and a hardcoded set of vendored / generated
 * directory names.
 *
 * Two-pass priority walk:
 *   • Pass 1 — high-signal source trees (any path with a segment in
 *     HIGH_SIGNAL_DIRS: src, lib, app, pages, components, services,
 *     controllers, routes, models, schemas, domain). No depth limit so
 *     deeply nested src/auth/services/guards/*.ts is reachable. Cap 500.
 *   • Pass 2 — everything else, depth ≤ 6. Cap 200. (Shallow config /
 *     manifests / top-level docs.)
 *   • Overall belt-and-suspenders cap: 3000. If exceeded, Pass 2 truncates
 *     before Pass 1.
 *
 * No prompts, no LLM calls, no side effects beyond reading files. Output is
 * a `RepoSummary` of:
 *   - top-level entries
 *   - file-count breakdowns by extension and by top-level dir
 *   - manifest previews (package.json / pyproject.toml / Gemfile / go.mod /
 *     Cargo.toml / mix.exs / deno.json / etc., first 80 lines each)
 *   - notable files (README, schema.prisma, openapi.{json,yaml}, Dockerfile,
 *     compose, AGENTS.md, etc.)
 *   - notable directories whose name matches common framework conventions
 *     (controllers, routes, handlers, services, models, migrations, schema,
 *     apps, packages, ...)
 *   - framework signals scraped out of manifest deps
 *
 * The mapper turns this into the project overlay (off_limits_globs,
 * key_modules, domain_summary, scope_index).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const DEFAULT_OFF_LIMITS_DIRS = new Set<string>([
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

/**
 * Per-pass + total caps. Per-pass caps keep the mapper prompt focused; the
 * 3000 total is a forward-looking safety net (the per-pass sum is well below
 * it but kept so future cap raises don't bypass a single bound).
 */
const HIGH_SIGNAL_DIRS = new Set<string>([
  "src",
  "lib",
  "app",
  "pages",
  "components",
  "services",
  "controllers",
  "routes",
  "models",
  "schemas",
  "domain",
]);
const DEFAULT_PASS1_CAP = 500;
const DEFAULT_PASS2_CAP = 200;
const DEFAULT_PASS2_DEPTH_CAP = 6;
const DEFAULT_TOTAL_CAP = 3000;
/** Single-pass depth cap, used by the fallback walker when no high-signal dirs match. */
const DEFAULT_DEPTH_CAP = 10;
const MANIFEST_PREVIEW_LINES = 80;

const MANIFEST_FILES = new Set<string>([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "Gemfile",
  "go.mod",
  "Cargo.toml",
  "mix.exs",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "Package.swift",
]);

const NOTABLE_FILE_PATTERNS: RegExp[] = [
  /^README(?:\.[a-z]+)?$/i,
  /^ARCHITECTURE\.[a-z]+$/i,
  /^DESIGN\.[a-z]+$/i,
  /^AGENTS?\.md$/i,
  /^CLAUDE\.md$/i,
  /^schema\.prisma$/i,
  /^openapi\.(?:json|yaml|yml)$/i,
  /^docker-compose(?:\.[a-z0-9_-]+)?\.ya?ml$/i,
  /^compose\.ya?ml$/i,
  /^Dockerfile(?:\..+)?$/i,
  /^drizzle\.config\.(?:ts|js|mts|mjs)$/i,
  /^prisma\.config\.(?:ts|js)$/i,
  /^next\.config\.(?:ts|js|mjs)$/i,
  /^nest-cli\.json$/i,
  /^astro\.config\.(?:ts|js|mjs)$/i,
  /^remix\.config\.(?:ts|js|mjs)$/i,
  /^tsconfig\.json$/i,
  /^tsconfig\.base\.json$/i,
  /^pnpm-workspace\.ya?ml$/i,
  /^turbo\.json$/i,
  /^nx\.json$/i,
  /^manage\.py$/i,
  /^alembic\.ini$/i,
  /^Procfile$/i,
];

const NOTABLE_DIR_NAMES = new Set<string>([
  "migrations",
  "schemas",
  "schema",
  "controllers",
  "routes",
  "handlers",
  "services",
  "models",
  "domain",
  "core",
  "apps",
  "packages",
  "src",
  "lib",
  "api",
  "web",
  "mobile",
  "frontend",
  "backend",
  "server",
  "client",
  "auth",
  "billing",
  "payments",
  "integrations",
  "telephony",
  "events",
  "dto",
  "dtos",
  "guards",
  "middlewares",
  "middleware",
  "queues",
  "workers",
]);

export interface ManifestPreview {
  path: string;
  preview: string;
}

export interface RepoSummary {
  repo_root: string;
  total_files: number;
  total_dirs: number;
  truncated_at_file_cap: boolean;
  truncated_at_depth_cap: boolean;
  used_git_ls_files: boolean;
  top_level: string[];
  package_manifests: ManifestPreview[];
  by_extension: Record<string, number>;
  by_top_dir: Record<string, number>;
  notable_files: string[];
  notable_dir_paths: string[];
  framework_signals: string[];
}

export interface BuildRepoSummaryOptions {
  repoRoot: string;
  /**
   * Hard cap on Pass-1 (high-signal-dir) file count. Default 500.
   */
  pass1Cap?: number;
  /**
   * Hard cap on Pass-2 (other) file count. Default 200.
   */
  pass2Cap?: number;
  /**
   * Max directory depth for Pass 2 (paths NOT under a high-signal dir).
   * Pass 1 has no depth limit. Default 6.
   */
  pass2DepthCap?: number;
  /**
   * Belt-and-suspenders total cap. Default 3000. If exceeded, Pass 2 is
   * truncated first.
   */
  fileCap?: number;
}

export function buildRepoSummary(opts: BuildRepoSummaryOptions): RepoSummary {
  const root = opts.repoRoot;
  const pass1Cap = opts.pass1Cap ?? DEFAULT_PASS1_CAP;
  const pass2Cap = opts.pass2Cap ?? DEFAULT_PASS2_CAP;
  const pass2DepthCap = opts.pass2DepthCap ?? DEFAULT_PASS2_DEPTH_CAP;
  const fileCap = opts.fileCap ?? DEFAULT_TOTAL_CAP;
  const { paths, dirs, truncatedFile, truncatedDepth, usedGit } = listFiles({
    root,
    pass1Cap,
    pass2Cap,
    pass2DepthCap,
    fileCap,
  });
  return summarize({
    root,
    paths,
    dirs,
    truncatedFile,
    truncatedDepth,
    usedGit,
  });
}

interface ListFilesArgs {
  root: string;
  pass1Cap: number;
  pass2Cap: number;
  pass2DepthCap: number;
  fileCap: number;
}

interface ListFilesResult {
  paths: string[];
  dirs: Set<string>;
  /** Set when any pass hit its file cap (Pass 1, Pass 2, or overall). */
  truncatedFile: boolean;
  /**
   * Set only by the single-pass walker fallback (rarely fires in real
   * repos). The two-pass walker leaves this false because it does not
   * depth-truncate paths under a high-signal dir.
   */
  truncatedDepth: boolean;
  usedGit: boolean;
}

function listFiles(args: ListFilesArgs): ListFilesResult {
  const fromGit = tryGitLsFiles(args.root);
  if (fromGit !== null) {
    return filterGitListing({ ...args, fromGit });
  }
  return walkFilesystem(args);
}

function isHighSignalPath(rel: string): boolean {
  for (const seg of rel.split("/")) {
    if (HIGH_SIGNAL_DIRS.has(seg)) return true;
  }
  return false;
}

function addAncestors(dirs: Set<string>, rel: string): void {
  const segs = rel.split("/");
  for (let i = 1; i <= segs.length - 1; i++) {
    dirs.add(segs.slice(0, i).join("/"));
  }
}

function tryGitLsFiles(root: string): string[] | null {
  if (!existsSync(join(root, ".git"))) return null;
  // We need TWO listings unioned because git ls-files cannot combine
  // `--recurse-submodules` with `--others` (git rejects it as "unsupported
  // mode"). Without --recurse-submodules, submodule contents (initialized or
  // not) never enumerate — `core/`, `platform/`, `site/` show as bare
  // gitlink entries and the mapper sees none of their source.
  //   1) `--cached --recurse-submodules` → tracked files including submodule contents
  //   2) `--others --exclude-standard`    → untracked-but-not-ignored files at parent
  const tracked = runGitLsFiles(root, [
    "--cached",
    "--recurse-submodules",
  ]);
  if (tracked === null) return null;
  const untracked = runGitLsFiles(root, ["--others", "--exclude-standard"]);
  if (untracked === null) return tracked;
  // Dedup — `--cached` and `--others` are disjoint by definition, but
  // submodule paths may appear in tracked as the bare gitlink in some git
  // versions; a Set keeps us safe.
  const set = new Set<string>();
  for (const p of tracked) set.add(p);
  for (const p of untracked) set.add(p);
  return [...set];
}

function runGitLsFiles(root: string, extraArgs: string[]): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", root, "ls-files", ...extraArgs, "-z"],
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

function filterGitListing(
  args: ListFilesArgs & { fromGit: string[] },
): ListFilesResult {
  const dirs = new Set<string>();
  const pass1: string[] = [];
  const pass2: string[] = [];
  let pass1Hit = false;
  let pass2Hit = false;

  // Single sweep — partition each path into pass1 (high-signal) or pass2.
  for (const rel of args.fromGit) {
    const segs = rel.split("/");
    if (segs.some((s) => DEFAULT_OFF_LIMITS_DIRS.has(s))) continue;
    if (isHighSignalPath(rel)) {
      if (pass1.length >= args.pass1Cap) {
        pass1Hit = true;
        continue;
      }
      pass1.push(rel);
      addAncestors(dirs, rel);
    } else {
      if (segs.length - 1 > args.pass2DepthCap) continue;
      if (pass2.length >= args.pass2Cap) {
        pass2Hit = true;
        continue;
      }
      pass2.push(rel);
      addAncestors(dirs, rel);
    }
  }

  const { combined, totalHit } = applyTotalCap(pass1, pass2, args.fileCap);
  return {
    paths: combined,
    dirs,
    truncatedFile: pass1Hit || pass2Hit || totalHit,
    truncatedDepth: false,
    usedGit: true,
  };
}

function walkFilesystem(args: ListFilesArgs): ListFilesResult {
  const dirs = new Set<string>();
  const pass1: string[] = [];
  const pass2: string[] = [];
  let pass1Hit = false;
  let pass2Hit = false;
  let truncatedDepth = false;
  // Stack frame carries `underHighSignal` so descendants of any high-signal
  // dir inherit Pass-1 classification AND skip the Pass-2 depth cap.
  type Frame = { abs: string; rel: string; depth: number; underHigh: boolean };
  const stack: Frame[] = [
    { abs: args.root, rel: "", depth: 0, underHigh: false },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(cur.abs);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (DEFAULT_OFF_LIMITS_DIRS.has(name)) continue;
      const abs = join(cur.abs, name);
      const rel = cur.rel === "" ? name : `${cur.rel}/${name}`;
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        const childUnderHigh = cur.underHigh || HIGH_SIGNAL_DIRS.has(name);
        // Pass-2 depth cap: only enforced for non-high-signal subtrees.
        if (!childUnderHigh && cur.depth + 1 > args.pass2DepthCap) {
          truncatedDepth = true;
          continue;
        }
        // Defensive belt: hard cap depth even under high-signal subtrees so
        // a runaway symlink loop or pathological tree can't OOM us.
        if (cur.depth + 1 > DEFAULT_DEPTH_CAP * 4) {
          truncatedDepth = true;
          continue;
        }
        dirs.add(rel);
        stack.push({
          abs,
          rel,
          depth: cur.depth + 1,
          underHigh: childUnderHigh,
        });
      } else if (s.isFile()) {
        if (cur.underHigh) {
          if (pass1.length >= args.pass1Cap) {
            pass1Hit = true;
            continue;
          }
          pass1.push(rel);
        } else {
          if (pass2.length >= args.pass2Cap) {
            pass2Hit = true;
            continue;
          }
          pass2.push(rel);
        }
      }
    }
  }
  const { combined, totalHit } = applyTotalCap(pass1, pass2, args.fileCap);
  return {
    paths: combined,
    dirs,
    truncatedFile: pass1Hit || pass2Hit || totalHit,
    truncatedDepth,
    usedGit: false,
  };
}

function applyTotalCap(
  pass1: string[],
  pass2: string[],
  totalCap: number,
): { combined: string[]; totalHit: boolean } {
  const combined = [...pass1, ...pass2];
  if (combined.length <= totalCap) return { combined, totalHit: false };
  // Drop Pass 2 first.
  const room = Math.max(0, totalCap - pass1.length);
  return {
    combined: pass1.slice(0, totalCap).concat(pass2.slice(0, room)),
    totalHit: true,
  };
}

interface SummarizeArgs {
  root: string;
  paths: string[];
  dirs: Set<string>;
  truncatedFile: boolean;
  truncatedDepth: boolean;
  usedGit: boolean;
}

function summarize(args: SummarizeArgs): RepoSummary {
  const byExt: Record<string, number> = {};
  const byTopDir: Record<string, number> = {};
  const manifests: ManifestPreview[] = [];
  const notableFiles: string[] = [];
  const topLevel = new Set<string>();
  for (const rel of args.paths) {
    const segs = rel.split("/");
    const top = segs[0];
    if (top !== undefined) topLevel.add(top);
    if (segs.length > 1 && top !== undefined) {
      byTopDir[top] = (byTopDir[top] ?? 0) + 1;
    }
    const ext = extname(rel).toLowerCase();
    if (ext.length > 0) byExt[ext] = (byExt[ext] ?? 0) + 1;
    const fileName = segs[segs.length - 1] ?? "";
    if (MANIFEST_FILES.has(fileName)) {
      manifests.push({
        path: rel,
        preview: readPreview(join(args.root, rel), MANIFEST_PREVIEW_LINES),
      });
    }
    if (NOTABLE_FILE_PATTERNS.some((p) => p.test(fileName))) {
      notableFiles.push(rel);
    }
  }
  const notableDirs = collectNotableDirs(args.dirs);
  const frameworkSignals = detectFrameworkSignals(manifests);
  return {
    repo_root: args.root,
    total_files: args.paths.length,
    total_dirs: args.dirs.size,
    truncated_at_file_cap: args.truncatedFile,
    truncated_at_depth_cap: args.truncatedDepth,
    used_git_ls_files: args.usedGit,
    top_level: [...topLevel].sort(),
    package_manifests: manifests,
    by_extension: topN(byExt, 25),
    by_top_dir: topN(byTopDir, 30),
    notable_files: notableFiles.sort(),
    notable_dir_paths: notableDirs.sort(),
    framework_signals: frameworkSignals.sort(),
  };
}

function collectNotableDirs(dirs: Set<string>): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    const segs = dir.split("/");
    const last = (segs[segs.length - 1] ?? "").toLowerCase();
    if (NOTABLE_DIR_NAMES.has(last)) out.push(dir);
  }
  return out;
}

function readPreview(path: string, maxLines: number): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.split("\n").slice(0, maxLines).join("\n");
  } catch {
    return "";
  }
}

function topN(m: Record<string, number>, n: number): Record<string, number> {
  const sorted = Object.entries(m)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n);
  const out: Record<string, number> = {};
  for (const [k, v] of sorted) out[k] = v;
  return out;
}

const TS_FRAMEWORKS = [
  "next",
  "@nestjs/core",
  "@nestjs/common",
  "express",
  "fastify",
  "hono",
  "@trpc/server",
  "drizzle-orm",
  "@prisma/client",
  "kysely",
  "@apollo/server",
  "apollo-server",
  "react",
  "vue",
  "svelte",
  "vite",
  "astro",
  "remix",
  "@sveltejs/kit",
  "nuxt",
  "@tanstack/router",
  "@tanstack/react-router",
  "tailwindcss",
  "react-native",
  "expo",
  "electron",
  "stripe",
  "discord.js",
  "zod",
  "graphql",
  "@effect/platform",
];

const PY_FRAMEWORKS = [
  "fastapi",
  "django",
  "flask",
  "starlette",
  "pydantic",
  "sqlalchemy",
  "alembic",
  "celery",
  "pytest",
  "ruff",
  "mypy",
  "uvicorn",
  "tortoise-orm",
];

const RB_FRAMEWORKS = [
  "rails",
  "sinatra",
  "sidekiq",
  "rspec",
  "rubocop",
  "hanami",
  "grape",
];

const GO_FRAMEWORKS = [
  "gin-gonic/gin",
  "go-chi/chi",
  "labstack/echo",
  "gofiber/fiber",
  "gorm.io/gorm",
  "sqlc-dev/sqlc",
  "uber-go/zap",
  "google/wire",
];

const RUST_FRAMEWORKS = [
  "axum",
  "actix-web",
  "rocket",
  "warp",
  "tower",
  "sqlx",
  "diesel",
  "sea-orm",
  "tokio",
];

function detectFrameworkSignals(manifests: ManifestPreview[]): string[] {
  const signals = new Set<string>();
  for (const m of manifests) {
    const fileName = m.path.split("/").pop() ?? "";
    const text = m.preview;
    if (fileName === "package.json") {
      for (const f of TS_FRAMEWORKS) {
        if (new RegExp(`"${escapeReg(f)}"\\s*:`, "i").test(text)) signals.add(f);
      }
    } else if (
      fileName === "pyproject.toml" ||
      fileName === "requirements.txt" ||
      fileName === "Pipfile"
    ) {
      for (const f of PY_FRAMEWORKS) {
        if (new RegExp(`\\b${escapeReg(f)}\\b`, "i").test(text)) signals.add(f);
      }
    } else if (fileName === "Gemfile") {
      for (const f of RB_FRAMEWORKS) {
        if (new RegExp(`gem\\s+["']${escapeReg(f)}["']`, "i").test(text)) {
          signals.add(f);
        }
      }
    } else if (fileName === "go.mod") {
      for (const f of GO_FRAMEWORKS) {
        if (text.includes(f)) signals.add(f);
      }
    } else if (fileName === "Cargo.toml") {
      for (const f of RUST_FRAMEWORKS) {
        if (new RegExp(`\\b${escapeReg(f)}\\s*=`, "i").test(text)) signals.add(f);
      }
    }
  }
  return [...signals];
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
