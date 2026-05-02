import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../logger.js";
import type { ClaudeTier } from "../claude/index.js";

const log = logger("orchestrator.runner");

const TIER_MODEL: Record<ClaudeTier, string> = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};

export interface ImplementerOptions {
  tier: ClaudeTier;
  prompt: string;
  /** Working directory for the agent — must be the mirror path. */
  cwd: string;
  /** Where stream events get appended (one JSON object per line). */
  eventsLogPath: string;
  /** Optional extra dirs to grant the agent — `--add-dir`. */
  addDirs?: string[];
  /** Optional `--allowed-tools` override. */
  allowedTools?: string[];
  /**
   * Claude Code permission mode for the run. Default: `bypassPermissions`
   * per operator preference 2026-05-02. The harness IS the trust boundary
   * for the dispatched agent — pre-dispatch sensors gate the spec, the
   * mirror constrains the writable surface, and the orchestrator FIFOs
   * runs sequentially. Inner permission prompts in `--print` mode add
   * friction without adding safety. Override per-run via this field if a
   * specific task needs a tighter mode.
   */
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default";
  /** Per-call timeout in ms. Default 600_000. */
  timeoutMs?: number;
  /** Called for every parsed event (incl. partials when enabled). */
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface ImplementerResult {
  /** Final result event (`type: "result"`). */
  result: Record<string, unknown>;
  /** Total parsed events including system + assistant + user + result. */
  events: number;
  /** Wall-clock duration of the subprocess. */
  durationMs: number;
  /** True when the result envelope's `is_error` field is falsy. */
  ok: boolean;
}

/**
 * Run the implementer agent via `claude --print --output-format stream-json`
 * and stream every event line to `eventsLogPath` (NDJSON). The final event
 * (type: "result") is returned to the caller.
 *
 * The agent operates in `cwd` (the mirror) and has access to the standard
 * Claude Code tool surface. It MUST NOT commit or push — those are later
 * phases. The `workflow.md` template's "Constraints" section enforces this
 * via instruction; future phases add hook-level enforcement.
 */
export async function runImplementer(opts: ImplementerOptions): Promise<ImplementerResult> {
  const model = TIER_MODEL[opts.tier];
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--no-session-persistence",
    "--verbose",
    "--permission-mode",
    opts.permissionMode ?? "bypassPermissions",
    "--model",
    model,
  ];
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(" "));
  }
  if (opts.addDirs && opts.addDirs.length > 0) {
    args.push("--add-dir", ...opts.addDirs);
  }

  await mkdir(dirname(opts.eventsLogPath), { recursive: true });

  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);

  return new Promise<ImplementerResult>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: ctrl.signal,
    });

    let stderr = "";
    let buffer = "";
    let eventCount = 0;
    let resultEvent: Record<string, unknown> | undefined;

    const writeQueue: Promise<void> = Promise.resolve();
    let writeChain = writeQueue;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch (err) {
        log.warn({ err: String(err), preview: trimmed.slice(0, 120) }, "stream line parse failed");
        return;
      }
      eventCount += 1;
      if (parsed["type"] === "result") resultEvent = parsed;
      writeChain = writeChain
        .then(() => appendFile(opts.eventsLogPath, `${trimmed}\n`, "utf8"))
        .catch((err) => log.warn({ err: String(err) }, "events log append failed"));
      if (opts.onEvent) {
        try {
          opts.onEvent(parsed);
        } catch (err) {
          log.warn({ err: String(err) }, "onEvent threw");
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Flush any trailing line.
      if (buffer.length > 0) handleLine(buffer);
      writeChain
        .then(() => {
          const durationMs = Date.now() - startedAt;
          if (code !== 0 && resultEvent === undefined) {
            reject(
              new Error(
                `claude (implementer) exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
              ),
            );
            return;
          }
          if (resultEvent === undefined) {
            reject(new Error(`implementer ended without a result event`));
            return;
          }
          const isErr = resultEvent["is_error"] === true;
          log.info(
            {
              model,
              durationMs,
              events: eventCount,
              ok: !isErr,
            },
            "implementer run complete",
          );
          resolve({
            result: resultEvent,
            events: eventCount,
            durationMs,
            ok: !isErr,
          });
        })
        .catch((err) => reject(err));
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
