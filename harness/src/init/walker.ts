/**
 * Repo walker — produces a structural inventory the init mapper consumes.
 *
 * Walks the adopted project's working tree at adoption time, respecting
 * `.gitignore` (via `git ls-files --cached --others --exclude-standard`
 * when a git repo is present) and a hardcoded set of vendored / generated
 * directory names. Caps both depth and total file count so the mapper
 * prompt stays bounded in token cost on large monorepos.
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
 * The mapper turns this into the `<slug>:` extension block (route_handler_globs,
 * dto_globs, generator_source_globs, high_stakes_globs, off_limits_globs,
 * pilot_module, key_modules, proposed_sensors, domain_summary).
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
  ".harness",
  ".archive",
]);

const DEFAULT_DEPTH_CAP = 5;
const DEFAULT_FILE_CAP = 3000;
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
  /** Max directory depth to descend. Default 5. */
  depthCap?: number;
  /** Hard cap on the number of files included. Default 3000. */
  fileCap?: number;
}

export function buildRepoSummary(opts: BuildRepoSummaryOptions): RepoSummary {
  const root = opts.repoRoot;
  const depthCap = opts.depthCap ?? DEFAULT_DEPTH_CAP;
  const fileCap = opts.fileCap ?? DEFAULT_FILE_CAP;
  const { paths, dirs, truncatedFile, truncatedDepth, usedGit } = listFiles({
    root,
    depthCap,
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
  depthCap: number;
  fileCap: number;
}

interface ListFilesResult {
  paths: string[];
  dirs: Set<string>;
  truncatedFile: boolean;
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

function tryGitLsFiles(root: string): string[] | null {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const out = execFileSync(
      "git",
      [
        "-C",
        root,
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

function filterGitListing(
  args: ListFilesArgs & { fromGit: string[] },
): ListFilesResult {
  const paths: string[] = [];
  const dirs = new Set<string>();
  let truncatedFile = false;
  let truncatedDepth = false;
  for (const rel of args.fromGit) {
    const segs = rel.split("/");
    if (segs.some((s) => DEFAULT_OFF_LIMITS_DIRS.has(s))) continue;
    if (segs.length - 1 > args.depthCap) {
      truncatedDepth = true;
      continue;
    }
    paths.push(rel);
    for (let i = 1; i <= segs.length - 1; i++) {
      dirs.add(segs.slice(0, i).join("/"));
    }
    if (paths.length >= args.fileCap) {
      truncatedFile = true;
      break;
    }
  }
  return { paths, dirs, truncatedFile, truncatedDepth, usedGit: true };
}

function walkFilesystem(args: ListFilesArgs): ListFilesResult {
  const paths: string[] = [];
  const dirs = new Set<string>();
  let truncatedFile = false;
  let truncatedDepth = false;
  const stack: { abs: string; rel: string; depth: number }[] = [
    { abs: args.root, rel: "", depth: 0 },
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
        if (cur.depth + 1 > args.depthCap) {
          truncatedDepth = true;
          continue;
        }
        dirs.add(rel);
        stack.push({ abs, rel, depth: cur.depth + 1 });
      } else if (s.isFile()) {
        paths.push(rel);
        if (paths.length >= args.fileCap) {
          truncatedFile = true;
          return { paths, dirs, truncatedFile, truncatedDepth, usedGit: false };
        }
      }
    }
  }
  return { paths, dirs, truncatedFile, truncatedDepth, usedGit: false };
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
