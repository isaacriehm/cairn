/**
 * `harness daemon` — single supervisor process.
 *
 * Spawns and supervises three things in one cohesive long-lived process:
 *   1. `harness watch --project <slug>` — grounding daemon (chokidar)
 *   2. `harness run --project <slug> --frontend <adapters>` — orchestrator
 *      + frontend adapters (Discord by default)
 *   3. periodic `harness gc run --apply-classes safe` — nightly cleanup
 *      (runs once on start + every 24h)
 *
 * Both child processes restart on crash with exponential backoff
 * (1s → 2s → 4s, capped at 60s; reset on a clean run > 30s). All output
 * tees into ~/.local/harness/logs/<slug>.{watch,run,gc}.log so launchd /
 * journalctl users have a single tail target.
 *
 * SIGINT / SIGTERM cleanly stop both children + the gc cron, then exit.
 *
 * Used by `harness install` (launchd plist) so a friend can `harness
 * install --project myapp` once and have everything come up on every
 * reboot under one supervised process — no tmux / two-terminal dance.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { logger } from "../logger.js";
import { normalizeProjectName } from "../mirror/index.js";

const log = logger("cli.daemon");

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.error(
    "Usage: harness daemon --project <slug> [options]\n" +
      "  --project       project slug (required)\n" +
      "  --frontend      adapter list for `harness run` (default: discord)\n" +
      "  --gc-interval   seconds between gc passes (default: 86400 = 24h)\n" +
      "  --no-gc         disable the periodic gc tick\n" +
      "  --log-dir       override log dir (default: ~/.local/harness/logs)\n" +
      "  --once          run children once + exit when both die (no restart)\n" +
      "\n" +
      "Single supervised process running watch + run + nightly gc. Logs to\n" +
      "<log-dir>/<slug>.{watch,run,gc}.log. SIGINT/SIGTERM stops everything.",
  );
  process.exit(1);
}

interface SuperviseArgs {
  project: string;
  frontends: string;
  logDir: string;
  once: boolean;
  gcIntervalSec: number | null;
  /** Resolved absolute path to the harness CLI binary (this process's argv[1]). */
  harnessBin: string;
  /** Node binary path. */
  nodeBin: string;
  /** Test seam — invoked when state transitions for visibility. */
  onEvent?: (event: SupervisorEvent) => void;
}

export type SupervisorEvent =
  | { kind: "started"; child: "watch" | "run" }
  | { kind: "exited"; child: "watch" | "run"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "restart-scheduled"; child: "watch" | "run"; delayMs: number }
  | { kind: "gc-tick"; ok: boolean; durationMs: number }
  | { kind: "stopped" };

interface SupervisedChild {
  name: "watch" | "run";
  args: string[];
  proc: ChildProcess | undefined;
  backoffMs: number;
  startedAt: number;
  /** When true, supervisor stops respawning. */
  stopped: boolean;
  logFd: number;
}

const RESET_BACKOFF_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

function openLog(dir: string, slug: string, label: string): number {
  mkdirSync(dir, { recursive: true });
  return openSync(resolve(dir, `${slug}.${label}.log`), "a");
}

function writeLine(fd: number, line: string): void {
  try {
    writeSync(fd, `${line}\n`);
  } catch {
    // best-effort
  }
}

function spawnChild(
  child: SupervisedChild,
  shared: { nodeBin: string; harnessBin: string },
): void {
  const proc = spawn(shared.nodeBin, [shared.harnessBin, ...child.args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.proc = proc;
  child.startedAt = Date.now();
  proc.stdout.on("data", (chunk: Buffer) => {
    writeSync(child.logFd, chunk);
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    writeSync(child.logFd, chunk);
  });
  writeLine(child.logFd, `\n── [supervisor] ${new Date().toISOString()} spawned ${child.name} (pid ${proc.pid})`);
}

async function supervise(args: SuperviseArgs): Promise<void> {
  const watchLogFd = openLog(args.logDir, args.project, "watch");
  const runLogFd = openLog(args.logDir, args.project, "run");
  const gcLogFd = openLog(args.logDir, args.project, "gc");
  const supervisorLogFd = openLog(args.logDir, args.project, "supervisor");

  writeLine(
    supervisorLogFd,
    `── ${new Date().toISOString()} supervisor start · project=${args.project} · frontends=${args.frontends}`,
  );

  const children: SupervisedChild[] = [
    {
      name: "watch",
      args: ["watch", "--project", args.project],
      proc: undefined,
      backoffMs: 1000,
      startedAt: 0,
      stopped: false,
      logFd: watchLogFd,
    },
    {
      name: "run",
      args: [
        "run",
        "--project",
        args.project,
        "--frontend",
        args.frontends,
      ],
      proc: undefined,
      backoffMs: 1000,
      startedAt: 0,
      stopped: false,
      logFd: runLogFd,
    },
  ];

  let stopRequested = false;
  let gcTimer: NodeJS.Timeout | undefined;

  const stopChild = async (child: SupervisedChild): Promise<void> => {
    child.stopped = true;
    if (child.proc !== undefined && child.proc.exitCode === null) {
      try {
        child.proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
      // Give it 10s grace then SIGKILL.
      await new Promise<void>((res) => {
        const grace = setTimeout(() => {
          if (child.proc !== undefined && child.proc.exitCode === null) {
            try {
              child.proc.kill("SIGKILL");
            } catch {
              // best-effort
            }
          }
          res();
        }, 10_000);
        child.proc?.once("exit", () => {
          clearTimeout(grace);
          res();
        });
      });
    }
  };

  const stopAll = async (): Promise<void> => {
    if (stopRequested) return;
    stopRequested = true;
    if (gcTimer !== undefined) clearInterval(gcTimer);
    writeLine(supervisorLogFd, `── ${new Date().toISOString()} stop signal received`);
    await Promise.all(children.map((c) => stopChild(c)));
    writeLine(supervisorLogFd, `── ${new Date().toISOString()} supervisor exit`);
    args.onEvent?.({ kind: "stopped" });
    closeSync(watchLogFd);
    closeSync(runLogFd);
    closeSync(gcLogFd);
    closeSync(supervisorLogFd);
  };

  process.on("SIGINT", () => {
    void stopAll().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void stopAll().then(() => process.exit(0));
  });

  const launch = (child: SupervisedChild): void => {
    if (child.stopped || stopRequested) return;
    spawnChild(child, { nodeBin: args.nodeBin, harnessBin: args.harnessBin });
    args.onEvent?.({ kind: "started", child: child.name });
    log.info(
      { child: child.name, pid: child.proc?.pid, args: child.args },
      "child spawned",
    );
    child.proc?.once("exit", (code, signal) => {
      writeLine(
        child.logFd,
        `── [supervisor] ${new Date().toISOString()} ${child.name} exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      args.onEvent?.({
        kind: "exited",
        child: child.name,
        code,
        signal,
      });
      log.warn({ child: child.name, code, signal }, "child exited");
      if (child.stopped || stopRequested) return;
      if (args.once) return;
      const ranLong = Date.now() - child.startedAt > RESET_BACKOFF_AFTER_MS;
      if (ranLong) child.backoffMs = 1000;
      const delay = child.backoffMs;
      child.backoffMs = Math.min(child.backoffMs * 2, MAX_BACKOFF_MS);
      args.onEvent?.({
        kind: "restart-scheduled",
        child: child.name,
        delayMs: delay,
      });
      writeLine(
        child.logFd,
        `── [supervisor] ${new Date().toISOString()} ${child.name} restart in ${delay}ms`,
      );
      setTimeout(() => launch(child), delay);
    });
  };

  for (const c of children) launch(c);

  // Periodic GC tick.
  if (args.gcIntervalSec !== null) {
    const runGc = async (): Promise<void> => {
      const startedAt = Date.now();
      writeLine(
        gcLogFd,
        `── ${new Date().toISOString()} gc tick start`,
      );
      try {
        await new Promise<void>((res, rej) => {
          const proc = spawn(
            args.nodeBin,
            [
              args.harnessBin,
              "gc",
              "run",
              "--apply-classes",
              "safe",
              "--repo-root",
              process.cwd(),
            ],
            { stdio: ["ignore", "pipe", "pipe"], env: process.env },
          );
          proc.stdout.on("data", (chunk: Buffer) => writeSync(gcLogFd, chunk));
          proc.stderr.on("data", (chunk: Buffer) => writeSync(gcLogFd, chunk));
          proc.on("exit", (code) => {
            if (code === 0) res();
            else rej(new Error(`gc exited ${code}`));
          });
          proc.on("error", rej);
        });
        const dur = Date.now() - startedAt;
        writeLine(gcLogFd, `── gc tick OK (${dur}ms)`);
        args.onEvent?.({ kind: "gc-tick", ok: true, durationMs: dur });
      } catch (err) {
        const dur = Date.now() - startedAt;
        writeLine(gcLogFd, `── gc tick FAIL (${dur}ms): ${String(err)}`);
        args.onEvent?.({ kind: "gc-tick", ok: false, durationMs: dur });
      }
    };
    // Fire once on start (after a 60s warmup so children are settled).
    setTimeout(() => void runGc(), 60_000);
    gcTimer = setInterval(() => void runGc(), args.gcIntervalSec * 1000);
  }
}

export async function daemonCli(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  if (flags["help"] === true || flags["h"] === true) usage();
  const slugRaw =
    typeof flags["project"] === "string" ? flags["project"] : "";
  if (slugRaw.length === 0) {
    console.error("harness daemon: --project required\n");
    usage();
  }
  const project = normalizeProjectName(slugRaw);
  const frontends =
    typeof flags["frontend"] === "string" ? flags["frontend"] : "discord";
  const logDir =
    typeof flags["log-dir"] === "string"
      ? resolve(flags["log-dir"])
      : resolve(homedir(), ".local", "harness", "logs");
  const once = flags["once"] === true;
  const gcIntervalSec =
    flags["no-gc"] === true
      ? null
      : typeof flags["gc-interval"] === "string"
        ? Math.max(60, Number.parseInt(flags["gc-interval"], 10) || 86400)
        : 86400;

  // Resolve the harness CLI binary path. In normal operation argv[1] is the
  // dist/cli/index.js file or a node_modules/.bin shim. We re-invoke it with
  // the same node binary for cross-platform consistency.
  const harnessBin = resolve(process.argv[1] ?? "");
  const nodeBin = process.execPath;

  await supervise({
    project,
    frontends,
    logDir,
    once,
    gcIntervalSec,
    harnessBin,
    nodeBin,
  });
}

/** Test seam — start a supervisor with custom event hook + return stop fn. */
export async function startSupervisorForTest(args: {
  project: string;
  frontends: string;
  logDir: string;
  harnessBin: string;
  nodeBin: string;
  onEvent: (event: SupervisorEvent) => void;
  gcIntervalSec?: number | null;
  once?: boolean;
}): Promise<{ stop: () => Promise<void> }> {
  let stopFn: () => Promise<void> = async () => {};
  await supervise({
    ...args,
    once: args.once ?? false,
    gcIntervalSec: args.gcIntervalSec ?? null,
    onEvent: (e) => {
      args.onEvent(e);
      if (e.kind === "stopped") {
        // noop — actual stop fn drives this
      }
    },
  });
  // We can't easily expose the real stop without restructuring supervise.
  // For test-time, send SIGTERM to ourselves is not appropriate. Instead,
  // surface a kill helper via process events.
  stopFn = async (): Promise<void> => {
    process.emit("SIGTERM");
  };
  return { stop: stopFn };
}
