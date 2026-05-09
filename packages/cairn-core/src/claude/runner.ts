import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { logger } from "../logger.js";
import { appendTrace } from "../trace/index.js";
import { cacheLookup, cacheStore } from "./cache.js";
import { ClaudeError, classifyClaudeError } from "./error.js";
import { z } from "zod";

const log = logger("claude.runner");

const ClaudeEnvelopeSchema = z.object({
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_tokens: z.number().optional(),
    cache_creation_tokens: z.number().optional(),
  }).optional(),
}).passthrough();

export type ClaudeTier = "h1" | "h2" | "h3" | "haiku" | "sonnet" | "opus";

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

export interface RunClaudeOptions {
  tier: ClaudeTier;
  prompt: string;
  system?: string;
  jsonSchema?: object;
  timeoutMs?: number;
  repoRoot?: string;
  sessionId?: string;
  purpose?: string;
  cacheable?: boolean;
  /** Force bypass global context (@CLAUDE.md, ~/.claude/) — recommended for internal tasks. */
  isolateAmbientContext?: boolean;
}

export interface RunClaudeResult {
  text: string;
  parsed?: unknown;
  durationMs: number;
  tier: ClaudeTier;
  model: string;
  envelope?: Record<string, unknown>;
  usage?: ClaudeUsage;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_CALLS = 3;

let activeCalls = 0;
const callQueue: (() => void)[] = [];

function acquireClaudeSlot(): Promise<void> {
  if (activeCalls < MAX_CONCURRENT_CALLS) {
    activeCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    callQueue.push(resolve);
  });
}

function releaseClaudeSlot(): void {
  activeCalls--;
  const next = callQueue.shift();
  if (next !== undefined) {
    activeCalls++;
    next();
  }
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
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    const args = ["-p", opts.isolateAmbientContext === true ? "none" : "auto"];
    if (opts.system !== undefined) args.push("--system", opts.system);
    if (opts.jsonSchema !== undefined) {
      args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    }

    const model = `claude-code/${opts.tier}`; // conceptual model name for telemetry

    return await new Promise<RunClaudeResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: opts.repoRoot ?? tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
      child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

      let settled = false;

      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const isAbort = err.name === "AbortError";
        if (isAbort) {
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
        reject(err);
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
        
        try {
          const parsedStdout: unknown = JSON.parse(stdout);
          const result = ClaudeEnvelopeSchema.safeParse(parsedStdout);
          if (!result.success) {
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
          const envelope = result.data;
          const text = envelope.result ?? "";
          let parsed: unknown;
          if (opts.jsonSchema !== undefined) {
            if (envelope.structured_output !== undefined) {
              parsed = envelope.structured_output;
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
          const usage = envelope.usage !== undefined ? {
            input_tokens: envelope.usage.input_tokens,
            output_tokens: envelope.usage.output_tokens,
            cache_read_tokens: envelope.usage.cache_read_tokens ?? null,
            cache_creation_tokens: envelope.usage.cache_creation_tokens ?? null,
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
            envelope: envelope as Record<string, unknown>,
            ...(usage !== undefined ? { usage } : {}),
          };
          if (opts.cacheable === true && opts.repoRoot !== undefined) {
            cacheStore(opts.repoRoot, opts, runResult);
          }
          resolve(runResult);
        } catch {
          reject(
            new ClaudeError({
              message: `claude output not JSON: ${stdout.slice(0, 200)}`,
              kind: "other",
              exitCode: code ?? 0,
              stderr,
            }),
          );
        }
      });

      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  } finally {
    releaseClaudeSlot();
  }
}

/** Truncated preview for trace. */
const TRACE_PREVIEW_CHARS = 600;
function preview(s: string): string {
  if (s.length <= TRACE_PREVIEW_CHARS) return s;
  return `${s.slice(0, TRACE_PREVIEW_CHARS)}…(+${s.length - TRACE_PREVIEW_CHARS} chars)`;
}
