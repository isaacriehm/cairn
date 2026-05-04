/**
 * Profile-free stack detection for `harness init`.
 *
 * Each detection function returns plain data; the wizard composes them.
 * No prompts, no side effects, no stdout writes. Detection is mechanical:
 * read filesystem signatures, return arrays of findings.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { simpleGit } from "simple-git";
import { claudeIsAvailable } from "../claude/index.js";
import { normalizeProjectName } from "../mirror/index.js";
import type {
  DetectionResult,
  HookCapability,
  SensorProposal,
  StackKind,
  StackSignature,
  StartCommand,
} from "./types.js";

const WHISPER_MODEL_PATH = `${process.env["HOME"] ?? ""}/.local/harness/models/ggml-large-v3-turbo-q5_0.bin`;
const OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "http://localhost:11434";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function detectProjectSlug(args: {
  repoRoot: string;
  originUrl: string | null;
}): string {
  const pkgPath = join(args.repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
      if (typeof pkg.name === "string" && pkg.name.length > 0) {
        return normalizeProjectName(pkg.name);
      }
    } catch {
      // fall through
    }
  }
  if (args.originUrl !== null) {
    const match = args.originUrl.match(/[/:]([^/]+?)(?:\.git)?$/);
    if (match?.[1]) return normalizeProjectName(match[1]);
  }
  return normalizeProjectName(basename(args.repoRoot));
}

export async function detectOriginUrl(repoRoot: string): Promise<string | null> {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  try {
    const remotes = await simpleGit(repoRoot).getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    return origin?.refs?.fetch ?? null;
  } catch {
    return null;
  }
}

export function detectStackSignatures(repoRoot: string): StackSignature[] {
  const signatures: StackSignature[] = [];
  const flag = (kind: StackKind, marker: string) => {
    if (existsSync(join(repoRoot, marker))) {
      signatures.push({ kind, marker });
    }
  };
  flag("typescript", "package.json");
  flag("python", "pyproject.toml");
  if (signatures.find((s) => s.kind === "python") === undefined) {
    flag("python", "requirements.txt");
  }
  flag("ruby", "Gemfile");
  flag("go", "go.mod");
  flag("rust", "Cargo.toml");
  flag("elixir", "mix.exs");
  if (signatures.length === 0) {
    signatures.push({ kind: "unknown", marker: repoRoot });
  }
  return signatures;
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
    const pyToml = readFileIfExists(join(args.repoRoot, "pyproject.toml"));
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
    const gemfile = readFileIfExists(join(args.repoRoot, "Gemfile"));
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
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
        const script = pkg.scripts?.["dev"] ?? pkg.scripts?.["start"];
        const scriptName = pkg.scripts?.["dev"] !== undefined ? "dev" : "start";
        if (script !== undefined) {
          return {
            command: "pnpm",
            args: ["run", scriptName],
            reason: `package.json scripts.${scriptName}: \`${script}\``,
          };
        }
      } catch {
        // fall through
      }
    }
  }

  // python: manage.py runserver; FastAPI uvicorn from Procfile/dev.sh
  if (args.signatures.some((s) => s.kind === "python")) {
    if (existsSync(join(args.repoRoot, "manage.py"))) {
      return {
        command: "python",
        args: ["manage.py", "runserver"],
        reason: "Django manage.py detected",
      };
    }
    const procfile = readFileIfExists(join(args.repoRoot, "Procfile"));
    if (procfile) {
      const webLine = procfile.split(/\r?\n/).find((l) => /^web:/i.test(l));
      if (webLine) {
        const cmdRaw = webLine.replace(/^web:\s*/i, "").trim();
        const parts = cmdRaw.split(/\s+/);
        if (parts.length > 0 && parts[0] !== undefined) {
          return {
            command: parts[0],
            args: parts.slice(1),
            reason: `Procfile web: ${cmdRaw}`,
          };
        }
      }
    }
  }

  // ruby: bin/rails server
  if (args.signatures.some((s) => s.kind === "ruby")) {
    if (existsSync(join(args.repoRoot, "bin", "rails"))) {
      return {
        command: "bin/rails",
        args: ["server"],
        reason: "bin/rails detected",
      };
    }
  }

  // go: best-guess `go run ./...`
  if (args.signatures.some((s) => s.kind === "go")) {
    return {
      command: "go",
      args: ["run", "./..."],
      reason: "go.mod present",
    };
  }

  // rust: cargo run
  if (args.signatures.some((s) => s.kind === "rust")) {
    return {
      command: "cargo",
      args: ["run"],
      reason: "Cargo.toml present",
    };
  }

  return null;
}

export function detectHookCapability(repoRoot: string): HookCapability {
  const claudeDir = join(repoRoot, ".claude");
  if (existsSync(claudeDir) && isDirectory(claudeDir)) return "claude-code";
  if (existsSync(join(repoRoot, ".git"))) return "git-hooks";
  return "cli-only";
}

async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function detectEnvironment(): Promise<DetectionResult["environment"]> {
  return {
    claude_auth: claudeIsAvailable(),
    whisper_model: existsSync(WHISPER_MODEL_PATH),
    ollama_running: await probeOllama(),
    discord_token:
      typeof process.env["DISCORD_BOT_TOKEN"] === "string" &&
      process.env["DISCORD_BOT_TOKEN"]!.length > 0,
    discord_guild:
      typeof process.env["DISCORD_GUILD_ID"] === "string" &&
      process.env["DISCORD_GUILD_ID"]!.length > 0,
  };
}

export async function detectAll(repoRoot: string): Promise<DetectionResult> {
  const originUrl = await detectOriginUrl(repoRoot);
  const project_slug = detectProjectSlug({ repoRoot, originUrl });
  const stack_signatures = detectStackSignatures(repoRoot);
  const proposed_sensors = detectAvailableSensors({
    repoRoot,
    signatures: stack_signatures,
  });
  const start_command = detectStartCommand({
    repoRoot,
    signatures: stack_signatures,
  });
  const hook_capability = detectHookCapability(repoRoot);
  const environment = await detectEnvironment();
  return {
    repo_root: repoRoot,
    project_slug,
    origin_url: originUrl,
    stack_signatures,
    proposed_sensors,
    start_command,
    hook_capability,
    environment,
  };
}

/* ───────────────────────── helpers ───────────────────────── */

function readFileIfExists(path: string): string | null {
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
