import { spawn, spawnSync } from "node:child_process";
import { logger } from "../logger.js";
import { ClaudeError, classifyClaudeError } from "./error.js";
import type { ClaudeTier, RunClaudeOptions, RunClaudeResult } from "./types.js";

const log = logger("claude.runner");

/** Tier → model alias passed to `claude --model`. */
const TIER_MODEL: Record<ClaudeTier, string> = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};

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
 * the operator's coding-plan subscription quota per L42.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
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
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  return new Promise<RunClaudeResult>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      signal: ctrl.signal,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const message = `claude exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`;
        const kind = classifyClaudeError({ message, exitCode: code, stderr });
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
      resolve({
        text,
        ...(parsed !== undefined ? { parsed } : {}),
        durationMs,
        tier: opts.tier,
        model,
        envelope,
        ...(usage !== undefined ? { usage } : {}),
      });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
