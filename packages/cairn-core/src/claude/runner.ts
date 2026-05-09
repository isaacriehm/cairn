import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import { logger } from "../logger.js";
import { appendTrace } from "../trace/index.js";
import { cacheLookup, cacheStore } from "./cache.js";
import { ClaudeError, classifyClaudeError } from "./error.js";
import type { ClaudeTier, RunClaudeOptions, RunClaudeResult } from "./types.js";

export type { ClaudeTier, ClaudeUsage, RunClaudeOptions, RunClaudeResult } from "./types.js";

const log = logger("claude.runner");

const ClaudeEnvelopeSchema = z.object({
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }).optional(),
}).passthrough();

/** Tier → model alias passed to `claude --model`. */
const TIER_MODEL: Record<ClaudeTier, string> = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};

/**
 * Global concurrency cap for Claude CLI subprocesses to prevent OS thread
 * exhaustion / OOM during high-volume Haiku batching.
 */
const MAX_CONCURRENT_CLAUDE = 8;
let currentClaudeCalls = 0;
const claudeQueue: (() => void)[] = [];

function acquireClaudeSlot(): Promise<void> {
  if (currentClaudeCalls < MAX_CONCURRENT_CLAUDE) {
    currentClaudeCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    claudeQueue.push(resolve);
  });
}

function releaseClaudeSlot(): void {
  currentClaudeCalls--;
  const next = claudeQueue.shift();
  if (next !== undefined) {
    currentClaudeCalls++;
    next();
  }
}

/** Cap previewed text in trace so payloads stay scannable (full body still in stderr/stdout if needed). */
const TRACE_PREVIEW_CHARS = 600;
function preview(s: string): string {
  if (s.length <= TRACE_PREVIEW_CHARS) return s;
  return `${s.slice(0, TRACE_PREVIEW_CHARS)}…(+${s.length - TRACE_PREVIEW_CHARS} chars)`;
}

/** Check if Claude Code is available on PATH. */
export function claudeIsAvailable(): boolean {
  try {
    const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Single entry point for all LLM calls. Invokes the `claude` CLI via
 * stdin/stdout. Serializes concurrency to avoid local resource exhaustion.
 */
export async function runClaude(
  opts: RunClaudeOptions,
): Promise<RunClaudeResult> {
  if (opts.cacheable === true && opts.repoRoot !== undefined) {
    const cached = cacheLookup(opts.repoRoot, opts);
    if (cached !== null) return cached;
  }

  await acquireClaudeSlot();
  try {
    const model = TIER_MODEL[opts.tier];
    const args = [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      model,
    ];
    if (opts.system !== undefined) {
      args.push("--system-prompt", opts.system);
    }
    if (opts.jsonSchema !== undefined) {
      args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    }
    if (opts.isolateAmbientContext === true) {
      args.push(
        "--setting-sources",
        "project,local",
        "--tools",
        "",
        "--disable-slash-commands",
      );
    }
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }

    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? 120_000;

    appendTrace({
      ts: new Date().toISOString(),
      source: "claude",
      kind: "request",
      repo_root: opts.repoRoot ?? null,
      session_id: opts.sessionId ?? null,
      payload: {
        tier: opts.tier,
        model,
        purpose: opts.purpose ?? null,
        prompt_chars: opts.prompt.length,
        system_chars: opts.system?.length ?? 0,
        json_schema: opts.jsonSchema !== undefined,
        prompt_preview: preview(opts.prompt),
        ...(opts.system !== undefined ? { system_preview: preview(opts.system) } : {}),
      },
    });

    const subprocessCwd =
      opts.isolateAmbientContext === true
        ? tmpdir()
        : opts.cwd ?? opts.repoRoot ?? process.cwd();

    return await new Promise<RunClaudeResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: subprocessCwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (timedOut) {
          const message = `claude timed out after ${timeoutMs}ms`;
          appendTrace({
            ts: new Date().toISOString(),
            source: "claude",
            kind: "response",
            repo_root: opts.repoRoot ?? null,
            session_id: opts.sessionId ?? null,
            duration_ms: Date.now() - startedAt,
            ok: false,
            payload: {
              tier: opts.tier,
              model,
              purpose: opts.purpose ?? null,
              error_kind: "timeout",
              exit_code: 143,
            },
          });
          reject(new ClaudeError({ message, kind: "timeout", exitCode: 143 }));
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        if (code !== 0) {
          const exitCode = code ?? 1;
          const message = `claude exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`;
          const kind = classifyClaudeError({ message, exitCode, stderr });
          appendTrace({
            ts: new Date().toISOString(),
            source: "claude",
            kind: "response",
            repo_root: opts.repoRoot ?? null,
            session_id: opts.sessionId ?? null,
            duration_ms: Date.now() - startedAt,
            ok: false,
            payload: {
              tier: opts.tier,
              model,
              purpose: opts.purpose ?? null,
              error_kind: kind,
              exit_code: exitCode,
              stderr_preview: preview(stderr),
            },
          });
          reject(new ClaudeError({ message, kind, exitCode, stderr }));
          return;
        }

        let envelope: Record<string, unknown>;
        try {
          envelope = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          reject(
            new ClaudeError({
              message: `claude output not JSON: ${stdout.slice(0, 200)}`,
              kind: "other",
              exitCode: code,
              stderr,
            }),
          );
          return;
        }

        const envResult = ClaudeEnvelopeSchema.safeParse(envelope);
        if (!envResult.success) {
          reject(
            new ClaudeError({
              message: `claude output JSON invalid: ${stdout.slice(0, 200)}`,
              kind: "other",
              exitCode: code ?? 0,
              stderr,
            }),
          );
          return;
        }

        const env = envResult.data;
        const text = env.result ?? "";
        let parsed: unknown;
        if (opts.jsonSchema !== undefined) {
          if (env.structured_output !== undefined) {
            parsed = env.structured_output;
          } else if (text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch (err) {
              log.warn(
                { err: String(err), preview: text.slice(0, 200) },
                "claude json output parse failed despite --json-schema",
              );
            }
          }
        }

        const usageRaw = env.usage;
        const usage = usageRaw !== undefined ? {
          input_tokens: usageRaw.input_tokens,
          output_tokens: usageRaw.output_tokens,
          ...(usageRaw.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usageRaw.cache_creation_input_tokens } : {}),
          ...(usageRaw.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usageRaw.cache_read_input_tokens } : {}),
        } : undefined;

        const durationMs = Date.now() - startedAt;
        log.info(
          {
            model,
            durationMs,
            input_tokens: usage?.input_tokens,
            output_tokens: usage?.output_tokens,
          },
          "claude call complete",
        );
        appendTrace({
          ts: new Date().toISOString(),
          source: "claude",
          kind: "response",
          repo_root: opts.repoRoot ?? null,
          session_id: opts.sessionId ?? null,
          duration_ms: durationMs,
          ok: true,
          payload: {
            tier: opts.tier,
            model,
            purpose: opts.purpose ?? null,
            input_tokens: usage?.input_tokens ?? null,
            output_tokens: usage?.output_tokens ?? null,
            response_chars: text.length,
            response_preview: preview(text),
            parsed_present: parsed !== undefined,
          },
        });

        const runResult: RunClaudeResult = {
          text,
          ...(parsed !== undefined ? { parsed } : {}),
          durationMs,
          tier: opts.tier,
          model,
          envelope,
          ...(usage !== undefined ? { usage } : {}),
        };
        if (opts.cacheable === true && opts.repoRoot !== undefined) {
          cacheStore(opts.repoRoot, opts, runResult);
        }
        resolve(runResult);
      });

      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  } finally {
    releaseClaudeSlot();
  }
}
