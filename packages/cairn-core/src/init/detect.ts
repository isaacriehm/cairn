/**
 * Profile-free stack detection for `cairn init`.
 *
 * Each detection function returns plain data; the wizard composes them.
 * No prompts, no side effects, no stdout writes. Detection is mechanical:
 * read filesystem signatures, parse package files, return proposals.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeProjectName } from "../paths/index.js";
import type {
  DetectionResult,
  HookCapability,
  StackKind,
  StackSignature,
  StartCommand,
} from "./types.js";
import { z } from "zod";

const PackageJsonSchema = z.object({
  name: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough();

export type PackageJson = z.infer<typeof PackageJsonSchema>;

/**
 * Top-level detection orchestration. Scans for stack signatures and
 * builds the detection summary for the operator.
 */
export function detectAll(args: { repoRoot: string }): DetectionResult {
  const originUrl = detectOriginUrl(args.repoRoot);
  const signatures = detectStackSignatures(args.repoRoot);
  const projectSlug = detectProjectSlug({ repoRoot: args.repoRoot, originUrl });

  return {
    repo_root: args.repoRoot,
    project_slug: projectSlug,
    origin_url: originUrl,
    stack_signatures: signatures,
    start_command: detectStartCommand({ repoRoot: args.repoRoot, signatures }),
    hook_capability: detectHookCapability(args.repoRoot).can_hook ? "claude-code" : "cli-only",
    environment: {
      claude_auth: true,
    },
  };
}

export function detectOriginUrl(repoRoot: string): string | null {
  const configPath = join(repoRoot, ".git", "config");
  if (!existsSync(configPath)) return null;
  try {
    const config = readFileSync(configPath, "utf8");
    const m = config.match(/\[remote "origin"\]\s+url\s*=\s*(.+)/);
    return m && m[1] ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function detectProjectSlug(args: {
  repoRoot: string;
  originUrl: string | null;
}): string {
  const pkgPath = join(args.repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = PackageJsonSchema.safeParse(parsed);
      if (result.success && result.data.name !== undefined) {
        return normalizeProjectName(result.data.name);
      }
    } catch {
      // fall through
    }
  }

  if (args.originUrl) {
    const slug = args.originUrl
      .split("/")
      .pop()
      ?.replace(/\.git$/, "");
    if (slug) return normalizeProjectName(slug);
  }

  const dirName = args.repoRoot.split(/[/\\]/).pop();
  return normalizeProjectName(dirName || "this-project");
}

/**
 * Manifest-file markers → stack id. An OPEN data table: extend the long tail
 * by adding a row, never by widening branching code. First marker per stack
 * wins (a python repo with both pyproject + requirements is one signature).
 */
const STACK_MARKERS: ReadonlyArray<{ marker: string; stackId: StackKind }> = [
  { marker: "package.json", stackId: "typescript" },
  { marker: "pyproject.toml", stackId: "python" },
  { marker: "requirements.txt", stackId: "python" },
  { marker: "Pipfile", stackId: "python" },
  { marker: "Gemfile", stackId: "ruby" },
  { marker: "go.mod", stackId: "go" },
  { marker: "Cargo.toml", stackId: "rust" },
  { marker: "mix.exs", stackId: "elixir" },
  { marker: "build.gradle.kts", stackId: "kotlin" },
  { marker: "build.gradle", stackId: "java" },
  { marker: "pom.xml", stackId: "java" },
  { marker: "composer.json", stackId: "php" },
  { marker: "pubspec.yaml", stackId: "dart" },
  { marker: "Package.swift", stackId: "swift" },
  { marker: "build.sbt", stackId: "scala" },
  { marker: "deps.edn", stackId: "clojure" },
  { marker: "project.clj", stackId: "clojure" },
  { marker: "stack.yaml", stackId: "haskell" },
  { marker: "CMakeLists.txt", stackId: "cpp" },
  { marker: "build.zig", stackId: "zig" },
];

/** Markers identified by extension in the repo root (project-file globs). */
const STACK_GLOB_MARKERS: ReadonlyArray<{ suffix: string; stackId: StackKind }> = [
  { suffix: ".csproj", stackId: "csharp" },
  { suffix: ".sln", stackId: "csharp" },
  { suffix: ".fsproj", stackId: "fsharp" },
  { suffix: ".cabal", stackId: "haskell" },
];

/**
 * Monorepo-shell markers. A JS/TS monorepo often has no dependency-bearing
 * `package.json` at the root — just a workspace manifest — so root-only
 * marker matching falls to `unknown`. These root files are a high-confidence
 * TypeScript/JS signal on their own.
 */
const MONOREPO_TS_MARKERS = [
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
] as const;

/** Workspace container dirs scanned one level deep when the root is bare. */
const WORKSPACE_DIRS = ["packages", "apps", "services", "libs", "modules"] as const;

/** Cap on child dirs scanned per container, so a huge monorepo stays fast. */
const SHALLOW_SCAN_DIR_CAP = 60;

/**
 * When the repo root carries no recognized manifest, look one level into the
 * conventional workspace containers (and immediate child dirs) for the same
 * manifest markers. Catches monorepos whose package manifests live in
 * subpackages rather than the root. Returns the first match per stack.
 */
function shallowScanForStacks(repoRoot: string): StackSignature[] {
  const out: StackSignature[] = [];
  const seen = new Set<string>();
  const add = (stackId: StackKind, marker: string): void => {
    if (seen.has(stackId)) return;
    out.push({ kind: stackId, marker });
    seen.add(stackId);
  };

  const containers: string[] = [];
  for (const d of WORKSPACE_DIRS) {
    if (isDirectory(join(repoRoot, d))) containers.push(join(repoRoot, d));
  }
  // Also treat immediate child dirs of the root as candidate package homes.
  containers.push(repoRoot);

  for (const container of containers) {
    let children: string[] = [];
    try {
      children = readdirSync(container);
    } catch {
      continue;
    }
    let scanned = 0;
    for (const name of children) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const childDir = join(container, name);
      if (!isDirectory(childDir)) continue;
      if (scanned >= SHALLOW_SCAN_DIR_CAP) break;
      scanned += 1;
      for (const { marker, stackId } of STACK_MARKERS) {
        if (seen.has(stackId)) continue;
        if (existsSync(join(childDir, marker))) {
          add(stackId, `${name}/${marker}`);
        }
      }
    }
  }
  return out;
}

export function detectStackSignatures(repoRoot: string): StackSignature[] {
  const out: StackSignature[] = [];
  const seen = new Set<string>();

  for (const { marker, stackId } of STACK_MARKERS) {
    if (seen.has(stackId)) continue;
    if (existsSync(join(repoRoot, marker))) {
      out.push({ kind: stackId, marker });
      seen.add(stackId);
    }
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    /* unreadable root — skip glob markers */
  }
  for (const { suffix, stackId } of STACK_GLOB_MARKERS) {
    if (seen.has(stackId)) continue;
    const hit = entries.find((e) => e.endsWith(suffix));
    if (hit !== undefined) {
      out.push({ kind: stackId, marker: hit });
      seen.add(stackId);
    }
  }

  // Monorepo-shell markers — a workspace manifest at the root is a strong
  // TypeScript/JS signal even when the root package.json carries no deps.
  for (const marker of MONOREPO_TS_MARKERS) {
    if (seen.has("typescript")) break;
    if (existsSync(join(repoRoot, marker))) {
      out.push({ kind: "typescript", marker });
      seen.add("typescript");
    }
  }

  // Still nothing at the root → scan one level into workspace containers so a
  // monorepo with manifests only in subpackages isn't mislabeled `unknown`.
  if (out.length === 0) {
    for (const sig of shallowScanForStacks(repoRoot)) {
      if (seen.has(sig.kind)) continue;
      out.push(sig);
      seen.add(sig.kind);
    }
  }

  // No coercion to a default: an unrecognized stack stays "unknown" and the
  // LLM mapper names it, rather than being mislabeled TypeScript.
  if (out.length === 0) out.push({ kind: "unknown", marker: "(none)" });
  return out;
}

export function detectStartCommand(args: {
  repoRoot: string;
  signatures: StackSignature[];
}): StartCommand | null {
  // typescript: prefer package.json scripts.dev > scripts.start
  if (args.signatures.some((s) => s.kind === "typescript")) {
    const pkgPath = join(args.repoRoot, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const raw = readFileSync(pkgPath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        const result = PackageJsonSchema.safeParse(parsed);
        if (result.success) {
          const pkg = result.data;
          const script = pkg.scripts?.["dev"] ?? pkg.scripts?.["start"];
          const scriptName = pkg.scripts?.["dev"] !== undefined ? "dev" : "start";
          if (script !== undefined) {
            return {
              command: "pnpm",
              args: ["run", scriptName],
              reason: `package.json scripts.${scriptName}: \`${script}\``,
            };
          }
        }
      } catch {
        // fall through
      }
    }
  }

  // Per-stack deterministic baselines for the unambiguous toolchains. Project
  // overrides come from the LLM mapper; an unrecognized stack returns null and
  // relies on it entirely (no JS default).
  for (const { stackId, command, args: cmdArgs, reason } of STACK_START_COMMANDS) {
    if (args.signatures.some((s) => s.kind === stackId)) {
      return { command, args: [...cmdArgs], reason };
    }
  }

  return null;
}

/** Unambiguous per-stack dev/run baselines. TS is handled above (scripts). */
const STACK_START_COMMANDS: ReadonlyArray<{
  stackId: StackKind;
  command: string;
  args: readonly string[];
  reason: string;
}> = [
  { stackId: "go", command: "go", args: ["run", "."], reason: "go.mod found; standard go run entrypoint" },
  { stackId: "rust", command: "cargo", args: ["run"], reason: "Cargo.toml found; standard cargo run entrypoint" },
  { stackId: "elixir", command: "mix", args: ["run", "--no-halt"], reason: "mix.exs found; standard mix run entrypoint" },
  { stackId: "dart", command: "dart", args: ["run"], reason: "pubspec.yaml found; standard dart run entrypoint" },
];

export interface HookCapabilityResult {
  can_hook: boolean;
  reason?: string;
}

export function detectHookCapability(repoRoot: string): HookCapabilityResult {
  const dotGit = join(repoRoot, ".git");
  if (!existsSync(dotGit)) return { can_hook: false, reason: "not a git repo" };

  try {
    const s = statSync(dotGit);
    if (!s.isDirectory()) return { can_hook: false, reason: ".git is a file (submodule?)" };
  } catch {
    return { can_hook: false, reason: ".git unreadable" };
  }

  return { can_hook: true };
}

export function detectEnvironment(): string {
  if (process.env["GITHUB_ACTIONS"] === "true") return "github-actions";
  if (process.env["VERCEL"] === "true") return "vercel";
  return "local";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
