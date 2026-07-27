import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { ModelRunnerError } from "./error.js";
import {
  MODEL_PROVIDERS,
  type ModelProvider,
} from "./types.js";

const COMMANDS: Record<ModelProvider, readonly string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  cursor: ["cursor-agent"],
};

let configuredProvider: ModelProvider | null = null;
const resolvedCommandCache = new Map<string, string>();

export function configureModelProvider(provider: ModelProvider | null): void {
  configuredProvider = provider;
}

function windowsCandidates(command: string): string[] {
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`];
}

function resolveOnWindows(provider: ModelProvider): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const command of COMMANDS[provider]) {
      for (const name of windowsCandidates(command)) {
        const full = join(dir, name);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

export function resolveProviderCommand(provider: ModelProvider): string | null {
  const cacheKey = `${process.platform}\0${process.env.PATH ?? ""}\0${provider}`;
  const cached = resolvedCommandCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (process.platform === "win32") {
    const command = resolveOnWindows(provider);
    if (command !== null) resolvedCommandCache.set(cacheKey, command);
    return command;
  }
  for (const command of COMMANDS[provider]) {
    try {
      const result = spawnSync(command, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
      if (result.status === 0) {
        resolvedCommandCache.set(cacheKey, command);
        return command;
      }
    } catch {
      // Try the provider's next documented alias.
    }
  }
  return null;
}

export function modelRunnerIsAvailable(provider?: ModelProvider): boolean {
  if (provider !== undefined) return resolveProviderCommand(provider) !== null;
  return MODEL_PROVIDERS.some((candidate) => resolveProviderCommand(candidate) !== null);
}

function pluginPreference(): ModelProvider | null {
  if (process.env["PLUGIN_ROOT"]) return "codex";
  if (process.env["CURSOR_PLUGIN_ROOT"]) return "cursor";
  if (process.env["CLAUDE_PLUGIN_ROOT"]) return "claude";
  return null;
}

function requireAvailable(provider: ModelProvider): ModelProvider {
  if (modelRunnerIsAvailable(provider)) return provider;
  throw new ModelRunnerError({
    message: `${provider} model provider selected, but its CLI executable is not available on PATH`,
    provider,
    kind: "unavailable",
  });
}

export function resolveModelProvider(explicit?: ModelProvider): ModelProvider {
  if (explicit !== undefined) return requireAvailable(explicit);
  if (configuredProvider !== null) return requireAvailable(configuredProvider);

  const preferred = pluginPreference();
  const order: ModelProvider[] =
    preferred === null
      ? ["claude", "codex", "cursor"]
      : [preferred, ...MODEL_PROVIDERS.filter((provider) => provider !== preferred)];
  for (const provider of order) {
    if (modelRunnerIsAvailable(provider)) return provider;
  }

  throw new ModelRunnerError({
    message:
      "no supported model CLI is available; install and authenticate Claude Code, Codex, or Cursor CLI",
    provider: null,
    kind: "unavailable",
  });
}

/** Resolve the active provider without forcing callers into exception control flow. */
export function tryResolveModelProvider(
  explicit?: ModelProvider,
): ModelProvider | null {
  try {
    return resolveModelProvider(explicit);
  } catch {
    return null;
  }
}
