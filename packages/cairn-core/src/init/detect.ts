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
  SensorProposal,
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
    proposed_sensors: detectAvailableSensors({ repoRoot: args.repoRoot, signatures }),
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

  // No coercion to a default: an unrecognized stack stays "unknown" and the
  // LLM mapper names it, rather than being mislabeled TypeScript.
  if (out.length === 0) out.push({ kind: "unknown", marker: "(none)" });
  return out;
}

export function detectAvailableSensors(args: {
  repoRoot: string;
  signatures: StackSignature[];
}): SensorProposal[] {
  const sensors: SensorProposal[] = [];
  const has = (path: string) => existsSync(join(args.repoRoot, path));
  const hasAny = (paths: string[]) => paths.some(has);

  // ── typescript ───────────────────────────────────────────
  if (args.signatures.some((s) => s.kind === "typescript")) {
    if (has("tsconfig.json") || has("tsconfig.base.json")) {
      sensors.push({
        id: "tsc",
        command: "pnpm",
        args: ["-w", "exec", "tsc", "-b", "--noEmit"],
        applies_to: ["typescript"],
        reason: "tsconfig.json present",
      });
    }
    if (
      hasAny([
        ".eslintrc",
        ".eslintrc.js",
        ".eslintrc.json",
        ".eslintrc.cjs",
        "eslint.config.js",
        "eslint.config.mjs",
      ])
    ) {
      sensors.push({
        id: "eslint",
        command: "pnpm",
        args: ["-w", "exec", "eslint", "."],
        applies_to: ["typescript"],
        reason: "eslint config present",
      });
    }
  }

  // ── python ───────────────────────────────────────────────
  if (args.signatures.some((s) => s.kind === "python")) {
    const pyToml = tryRead(join(args.repoRoot, "pyproject.toml"));
    if (has("ruff.toml") || (pyToml && /\[tool\.ruff\]/.test(pyToml))) {
      sensors.push({
        id: "ruff",
        command: "ruff",
        args: ["check", "."],
        applies_to: ["python"],
        reason: "ruff config present",
      });
    }
    if (has("mypy.ini") || (pyToml && /\[tool\.mypy\]/.test(pyToml))) {
      sensors.push({
        id: "mypy",
        command: "mypy",
        args: ["."],
        applies_to: ["python"],
        reason: "mypy config present",
      });
    }
  }

  // ── ruby ─────────────────────────────────────────────────
  if (args.signatures.some((s) => s.kind === "ruby")) {
    const gemfile = tryRead(join(args.repoRoot, "Gemfile"));
    if (has(".rubocop.yml") || (gemfile && /\brubocop\b/.test(gemfile))) {
      sensors.push({
        id: "rubocop",
        command: "bundle",
        args: ["exec", "rubocop"],
        applies_to: ["ruby"],
        reason: "rubocop config / dep present",
      });
    }
    if (gemfile && /\brails\b/.test(gemfile)) {
      sensors.push({
        id: "brakeman",
        command: "bundle",
        args: ["exec", "brakeman", "--no-pager"],
        applies_to: ["ruby"],
        reason: "rails app detected",
        needs_install: true,
      });
    }
  }

  // ── go ───────────────────────────────────────────────────
  if (args.signatures.some((s) => s.kind === "go")) {
    sensors.push({
      id: "go-vet",
      command: "go",
      args: ["vet", "./..."],
      applies_to: ["go"],
      reason: "go.mod present",
    });
    sensors.push({
      id: "gofmt",
      command: "gofmt",
      args: ["-l", "."],
      applies_to: ["go"],
      reason: "go.mod present",
    });
  }

  // ── rust ─────────────────────────────────────────────────
  if (args.signatures.some((s) => s.kind === "rust")) {
    sensors.push({
      id: "cargo-check",
      command: "cargo",
      args: ["check"],
      applies_to: ["rust"],
      reason: "Cargo.toml present",
    });
    sensors.push({
      id: "cargo-clippy",
      command: "cargo",
      args: ["clippy", "--", "-D", "warnings"],
      applies_to: ["rust"],
      reason: "Cargo.toml present",
    });
  }

  // ── elixir ───────────────────────────────────────────────
  if (args.signatures.some((s) => s.kind === "elixir")) {
    sensors.push({
      id: "mix-compile-warnings",
      command: "mix",
      args: ["compile", "--warnings-as-errors"],
      applies_to: ["elixir"],
      reason: "mix.exs present",
    });
  }

  return sensors;
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

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
