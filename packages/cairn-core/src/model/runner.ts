import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTrace } from "../trace/index.js";
import { logger } from "../logger.js";
import { cacheLookup, cacheStore } from "./cache.js";
import {
  asModelRunnerError,
  classifyModelError,
  ModelRunnerError,
} from "./error.js";
import {
  resolveModelProvider,
  resolveProviderCommand,
} from "./provider.js";
import { parseAndValidateStructuredOutput } from "./structured-output.js";
import { buildClaudeInvocation } from "./transports/claude.js";
import { buildCodexInvocation } from "./transports/codex.js";
import { buildCursorInvocation } from "./transports/cursor.js";
import type {
  BuildModelInvocation,
  ModelInvocation,
} from "./transports/types.js";
import type {
  ModelProvider,
  RunModelOptions,
  RunModelResult,
} from "./types.js";

export type {
  ModelProvider,
  ModelTier,
  ModelUsage,
  RunModelOptions,
  RunModelResult,
} from "./types.js";

const log = logger("model.runner");
const MAX_CONCURRENT_MODEL_CALLS = 8;
const TRACE_PREVIEW_CHARS = 600;

const TRANSPORTS: Record<ModelProvider, BuildModelInvocation> = {
  claude: buildClaudeInvocation,
  codex: buildCodexInvocation,
  cursor: buildCursorInvocation,
};

let activeCalls = 0;
const queue: Array<() => void> = [];

function preview(value: string): string {
  if (value.length <= TRACE_PREVIEW_CHARS) return value;
  return `${value.slice(0, TRACE_PREVIEW_CHARS)}…(+${value.length - TRACE_PREVIEW_CHARS} chars)`;
}

function acquireSlot(): Promise<void> {
  if (activeCalls < MAX_CONCURRENT_MODEL_CALLS) {
    activeCalls += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function releaseSlot(): void {
  activeCalls -= 1;
  const next = queue.shift();
  if (next !== undefined) {
    activeCalls += 1;
    next();
  }
}

function traceResponse(args: {
  options: RunModelOptions;
  provider: ModelProvider;
  model: string;
  startedAt: number;
  ok: boolean;
  errorKind?: string;
  exitCode?: number;
  stderr?: string;
  text?: string;
  parsed?: unknown;
  usage?: { input_tokens: number; output_tokens: number };
}): void {
  appendTrace({
    ts: new Date().toISOString(),
    source: "model",
    kind: "response",
    repo_root: args.options.repoRoot ?? null,
    session_id: args.options.sessionId ?? null,
    duration_ms: Date.now() - args.startedAt,
    ok: args.ok,
    payload: {
      provider: args.provider,
      tier: args.options.tier,
      model: args.model,
      purpose: args.options.purpose ?? null,
      ...(args.errorKind === undefined ? {} : { error_kind: args.errorKind }),
      ...(args.exitCode === undefined ? {} : { exit_code: args.exitCode }),
      ...(args.stderr === undefined
        ? {}
        : { stderr_preview: preview(args.stderr) }),
      ...(args.text === undefined
        ? {}
        : {
            response_chars: args.text.length,
            response_preview: preview(args.text),
            parsed_present: args.parsed !== undefined,
          }),
      ...(args.usage === undefined
        ? {}
        : {
            input_tokens: args.usage.input_tokens,
            output_tokens: args.usage.output_tokens,
          }),
    },
  });
}

async function executeInvocation(
  invocation: ModelInvocation,
  options: RunModelOptions,
): Promise<RunModelResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  appendTrace({
    ts: new Date().toISOString(),
    source: "model",
    kind: "request",
    repo_root: options.repoRoot ?? null,
    session_id: options.sessionId ?? null,
    payload: {
      provider: invocation.provider,
      tier: options.tier,
      model: invocation.model,
      purpose: options.purpose ?? null,
      prompt_chars: options.prompt.length,
      system_chars: options.system?.length ?? 0,
      json_schema: options.jsonSchema !== undefined,
      prompt_preview: preview(options.prompt),
      ...(options.system === undefined
        ? {}
        : { system_preview: preview(options.system) }),
    },
  });

  return await new Promise<RunModelResult>((resolve, reject) => {
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      invocation.cleanup();
    };
    const child = (() => {
      try {
        return spawn(invocation.command, invocation.args, {
          cwd: invocation.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        cleanup();
        const wrapped = asModelRunnerError(err, invocation.provider);
        traceResponse({
          options,
          provider: invocation.provider,
          model: invocation.model,
          startedAt,
          ok: false,
          errorKind: wrapped.kind,
        });
        throw wrapped;
      }
    })();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      cleanup();
      const wrapped = asModelRunnerError(err, invocation.provider);
      traceResponse({
        options,
        provider: invocation.provider,
        model: invocation.model,
        startedAt,
        ok: false,
        errorKind: wrapped.kind,
      });
      reject(wrapped);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      try {
        if (timedOut) {
          traceResponse({
            options,
            provider: invocation.provider,
            model: invocation.model,
            startedAt,
            ok: false,
            errorKind: "timeout",
            exitCode: 143,
          });
          reject(new ModelRunnerError({
            message: `${invocation.provider} model call timed out after ${timeoutMs}ms`,
            provider: invocation.provider,
            kind: "timeout",
            exitCode: 143,
          }));
          return;
        }
        if (code !== 0) {
          const exitCode = code ?? 1;
          const message =
            `${invocation.provider} exited ${exitCode}` +
            (stderr.length === 0 ? "" : `: ${stderr.trim()}`);
          const kind = classifyModelError({ message, exitCode, stderr });
          traceResponse({
            options,
            provider: invocation.provider,
            model: invocation.model,
            startedAt,
            ok: false,
            errorKind: kind,
            exitCode,
            stderr,
          });
          reject(new ModelRunnerError({
            message,
            provider: invocation.provider,
            kind,
            exitCode,
            stderr,
          }));
          return;
        }

        const decoded = invocation.decode(stdout);
        const parsed =
          options.jsonSchema === undefined
            ? decoded.parsed
            : parseAndValidateStructuredOutput({
                provider: invocation.provider,
                text: decoded.text,
                ...(decoded.parsed === undefined
                  ? {}
                  : { nativeParsed: decoded.parsed }),
                schema: options.jsonSchema,
              });
        const durationMs = Date.now() - startedAt;
        const result: RunModelResult = {
          text: decoded.text,
          ...(parsed === undefined ? {} : { parsed }),
          durationMs,
          provider: invocation.provider,
          tier: options.tier,
          model: invocation.model,
          ...(decoded.envelope === undefined
            ? {}
            : { envelope: decoded.envelope }),
          ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
          cached: false,
        };
        traceResponse({
          options,
          provider: invocation.provider,
          model: invocation.model,
          startedAt,
          ok: true,
          text: decoded.text,
          ...(parsed === undefined ? {} : { parsed }),
          ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
        });
        resolve(result);
      } catch (err) {
        const wrapped = asModelRunnerError(err, invocation.provider, stderr);
        traceResponse({
          options,
          provider: invocation.provider,
          model: invocation.model,
          startedAt,
          ok: false,
          errorKind: wrapped.kind,
          stderr,
        });
        reject(wrapped);
      } finally {
        cleanup();
      }
    });

    child.stdin.on("error", () => {
      // The close/error path owns settlement and diagnostics.
    });
    child.stdin.end(invocation.stdin);
  });
}

export async function runModel(
  options: RunModelOptions,
): Promise<RunModelResult> {
  const provider = resolveModelProvider(options.provider);
  if (options.cacheable === true && options.repoRoot !== undefined) {
    const cached = cacheLookup(options.repoRoot, provider, options);
    if (cached !== null) {
      appendTrace({
        ts: new Date().toISOString(),
        source: "model",
        kind: "cache_hit",
        repo_root: options.repoRoot,
        session_id: options.sessionId ?? null,
        duration_ms: cached.durationMs,
        ok: true,
        payload: {
          provider,
          tier: options.tier,
          model: cached.model,
          purpose: options.purpose ?? null,
          response_chars: cached.text.length,
          parsed_present: cached.parsed !== undefined,
        },
      });
      return cached;
    }
  }

  await acquireSlot();
  let isolatedDir: string | null = null;
  try {
    const command = resolveProviderCommand(provider);
    if (command === null) {
      throw new ModelRunnerError({
        message: `${provider} CLI became unavailable before the model call started`,
        provider,
        kind: "unavailable",
      });
    }
    const mustIsolate =
      options.isolateAmbientContext === true || provider === "cursor";
    const cwd =
      mustIsolate
        ? (isolatedDir = mkdtempSync(join(tmpdir(), "cairn-model-cwd-")))
        : options.cwd ?? options.repoRoot ?? process.cwd();
    const invocation = TRANSPORTS[provider]({
      command,
      cwd,
      tier: options.tier,
      options,
    });
    const result = await executeInvocation(invocation, options);
    if (options.cacheable === true && options.repoRoot !== undefined) {
      cacheStore(options.repoRoot, provider, options, result);
    }
    log.info(
      {
        provider,
        tier: options.tier,
        model: result.model,
        durationMs: result.durationMs,
        input_tokens: result.usage?.input_tokens,
        output_tokens: result.usage?.output_tokens,
      },
      "model call complete",
    );
    return result;
  } finally {
    if (isolatedDir !== null) {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
    releaseSlot();
  }
}
