/**
 * Init visual primitives — chalk-coloured icons and ora spinners.
 * All helpers degrade gracefully when stdout isn't a TTY (smokes, CI).
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";

// ── Cancellation registry ─────────────────────────────────────────────
//
// ora and cli-progress both hide the terminal cursor while running. If the
// operator hits Ctrl+C / Esc, we need to (1) stop the active widget so the
// hidden-cursor state is released, and (2) print a clean cancel line. The
// SIGINT handler iterates this registry then calls `showCursor()` and exits.

type CleanupFn = () => void;
const cleanupRegistry = new Set<CleanupFn>();
let signalHandlerInstalled = false;
let escListenerInstalled = false;

function registerCleanup(fn: CleanupFn): () => void {
  cleanupRegistry.add(fn);
  return () => cleanupRegistry.delete(fn);
}

function showCursor(): void {
  if (process.stdout.isTTY === true) {
    process.stdout.write("\x1B[?25h");
  }
}

function runAllCleanups(): void {
  for (const fn of cleanupRegistry) {
    try {
      fn();
    } catch {
      // best-effort
    }
  }
  cleanupRegistry.clear();
}

/**
 * Install signal handlers for SIGINT (Ctrl+C) and SIGTERM that release any
 * active spinner / progress bar, restore the cursor, and exit 130. Idempotent.
 *
 * Also wires an Esc-key listener on stdin so operators can abort with a single
 * keystroke when an inquirer or readline prompt is active. Esc is a soft
 * interrupt — same effect as Ctrl+C but no signal.
 *
 * Call this at the top of `runInit`. Tests / smokes that don't run interactively
 * should not call it (they pass mode = "auto" which never hits an interactive
 * widget anyway).
 */
export function installInitCancelHandlers(): void {
  if (!signalHandlerInstalled) {
    signalHandlerInstalled = true;
    const onSignal = (signal: NodeJS.Signals): void => {
      runAllCleanups();
      showCursor();
      process.stdout.write(
        `\n${chalk.yellow("⚠")}  cancelled (${signal})\n`,
      );
      process.exit(130);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGHUP", () => onSignal("SIGHUP"));
  }

  if (!escListenerInstalled && process.stdin.isTTY === true) {
    escListenerInstalled = true;
    // Use a low-overhead readable hook that watches each chunk for the Esc
    // byte (0x1B) followed by no continuation. Inquirer / readline already
    // put stdin into raw mode while a prompt is active, so this listener is
    // idle outside prompts and only consumes one byte when Esc fires.
    process.stdin.on("data", (chunk: Buffer) => {
      // Plain Esc keypress = a single 0x1B byte. Esc-then-other = arrow keys
      // / control sequences (e.g. 0x1B 0x5B 0x41 = up arrow). Skip those.
      if (chunk.length === 1 && chunk[0] === 0x1b) {
        runAllCleanups();
        showCursor();
        process.stdout.write(`\n${chalk.yellow("⚠")}  cancelled\n`);
        process.exit(130);
      }
    });
  }
}

type DiscoveryStatus = "ok" | "warn" | "err" | "info";

function icon(status: DiscoveryStatus): string {
  switch (status) {
    case "ok":
      return chalk.green("✓");
    case "warn":
      return chalk.yellow("⚠");
    case "err":
      return chalk.red("✗");
    case "info":
      return chalk.dim("•");
  }
}

/**
 * Print one streamed row in the discovery section. Format:
 *   `    {icon}  {label}    {value}`
 * label is left-padded to a stable column so values line up.
 */
export function discoveryRow(opts: {
  status: DiscoveryStatus;
  label: string;
  value?: string;
  /** Padding width for label. Default 14 chars. */
  labelWidth?: number;
}): void {
  const width = opts.labelWidth ?? 14;
  const label = opts.label.padEnd(width);
  const value = opts.value ?? "";
  process.stdout.write(`    ${icon(opts.status)}  ${chalk.dim(label)} ${value}\n`);
}

/** A simple long-task spinner. Returns control object with succeed/fail. */
interface SpinnerHandle {
  succeed(text?: string): void;
  fail(text?: string): void;
  update(text: string): void;
  /** Stop the spinner without printing a final state. */
  stop(): void;
}

export function startSpinner(text: string): SpinnerHandle {
  const tty = process.stdout.isTTY === true;
  if (!tty) {
    process.stdout.write(`  ↻  ${text}\n`);
    return {
      succeed: (final) => {
        if (final !== undefined) process.stdout.write(`  ${icon("ok")}  ${final}\n`);
      },
      fail: (final) => {
        if (final !== undefined) process.stdout.write(`  ${icon("err")}  ${final}\n`);
      },
      update: () => {
        // no-op in non-tty mode
      },
      stop: () => {
        // no-op
      },
    };
  }
  const spinner: Ora = ora({
    text,
    color: "cyan",
    indent: 2,
  }).start();
  // Hidden-cursor escape on signal. ora restores cursor as part of stop().
  const unregister = registerCleanup(() => {
    try {
      spinner.stop();
    } catch {
      // best-effort
    }
  });
  return {
    succeed: (final) => {
      unregister();
      spinner.succeed(final);
    },
    fail: (final) => {
      unregister();
      spinner.fail(final);
    },
    update: (next) => {
      spinner.text = next;
    },
    stop: () => {
      unregister();
      spinner.stop();
    },
  };
}

export const c = {
  bold: (s: string): string => chalk.bold(s),
  dim: (s: string): string => chalk.dim(s),
  green: (s: string): string => chalk.green(s),
  yellow: (s: string): string => chalk.yellow(s),
  red: (s: string): string => chalk.red(s),
  cyan: (s: string): string => chalk.cyan(s),
};
