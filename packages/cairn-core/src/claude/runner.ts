import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { logger } from "../logger.js";
import { appendTrace } from "../trace/index.js";
import { cacheLookup, cacheStore } from "./cache.js";
import { ClaudeError, classifyClaudeError } from "./error.js";
import type { ClaudeTier, RunClaudeOptions, RunClaudeResult } from "./types.js";

const log = logger("claude.runner");

/** Cap previewed text in trace so payloads stay scannable (full body still in stderr/stdout if needed). */
const TRACE_PREVIEW_CHARS = 600;
function preview(s: string): string {
  if (s.length <= TRACE_PREVIEW_CHARS) return s;
  return `${s.slice(0, TRACE_PREVIEW_CHARS)}…(+${s.length - TRACE_PREVIEW_CHARS} chars)`;
}

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

async function acquireClaudeSlot(): Promise<void> {
  if (currentClaudeCalls < MAX_CONCURRENT_CLAUDE) {
    currentClaudeCalls++;
    return;
  }
  return new Promise((resolve) => {
    claudeQueue.push(resolve);
  });
}

function releaseClaudeSlot(): void {
  currentClaudeCalls--;
  const next = claudeQueue.shift();
  if (next) {
    currentClaudeCalls++;
    next();
  }
}

/** Returns true when `claude --version` succeeds. Used at startup + smoke. */
export function claudeIsAvailable(): boolean {
  try {
    const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run a single non-interactive Claude Code call via subprocess.
 *
 * Auth path: relies on the operator's existing Claude Code login (OAuth /
 * keychain). No `--bare`, no `ANTHROPIC_API_KEY`. The whole point is to use
 * the operator's Claude Code coding-plan subscription quota.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  // Cache lookup happens before subprocess spawn so a hit short-circuits
  // the whole flow including the trace request event.
  if (opts.cacheable === true && opts.repoRoot !== undefined) {
    const hit = cacheLookup(opts.repoRoot, opts);
    if (hit !== null) return hit;
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
    // Isolate ambient context: drop user-level CLAUDE.md, project-hierarchy
    // CLAUDE.md, MCP tools, and plugin slash commands so the call sees only
    // the caller-supplied prompt + system. Subprocess runs from
    // `os.tmpdir()` so no CLAUDE.md ancestor chain auto-loads. Caller still
    // pays for whatever they explicitly include in the prompt.
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
    const ctrl = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

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

    // Subprocess cwd: when isolating ambient context, route to os.tmpdir()
    // so the CLAUDE.md ancestor chain doesn't auto-load. Otherwise honor
    // the caller's cwd (mapper needs the repo cwd for tool access).
    const subprocessCwd =
      opts.isolateAmbientContext === true
        ? tmpdir()
        : opts.cwd ?? process.cwd();

    return await new Promise<RunClaudeResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: subprocessCwd,
        stdio: ["pipe", "pipe", "pipe"],
        signal: ctrl.signal,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const isAbort = (err as { name?: string }).name === "AbortError";
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
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          const message = `claude exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`;
          const kind = classifyClaudeError({ message, exitCode: code, stderr });
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
              exit_code: code,
              stderr_preview: preview(stderr),
            },
          });
          reject(new ClaudeError({ message, kind, exitCode: code, stderr }));
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
        const text = typeof envelope["result"] === "string" ? envelope["result"] : "";
        let parsed: unknown;
        if (opts.jsonSchema !== undefined) {
          // The CLI puts schema-validated payload in `structured_output`, not
          // in `result` (which holds the conversational ack). Prefer that;
          // fall back to parsing the result text in case future versions
          // change the placement.
          if (envelope["structured_output"] !== undefined) {
            parsed = envelope["structured_output"];
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
        const usageRaw = envelope["usage"];
        const usage =
          typeof usageRaw === "object" && usageRaw !== null
            ? (usageRaw as Record<string, number>)
            : undefined;
        const durationMs = Date.now() - startedAt;
        log.info(
          {
            model,
            durationMs,
            input_tokens: usage?.["input_tokens"],
            output_tokens: usage?.["output_tokens"],
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
            input_tokens: usage?.["input_tokens"] ?? null,
            output_tokens: usage?.["output_tokens"] ?? null,
            response_chars: text.length,
            response_preview: preview(text),
            parsed_present: parsed !== undefined,
          },
        });
        const result: RunClaudeResult = {
          text,
          ...(parsed !== undefined ? { parsed } : {}),
          durationMs,
          tier: opts.tier,
          model,
          envelope,
          ...(usage !== undefined ? { usage } : {}),
        };
        if (opts.cacheable === true && opts.repoRoot !== undefined) {
          cacheStore(opts.repoRoot, opts, result);
        }
        resolve(result);
      });

      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  } finally {
    releaseClaudeSlot();
  }
}
