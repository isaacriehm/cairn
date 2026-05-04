/**
 * Init visual primitives — chalk-coloured icons, ora spinners, cli-progress
 * bars. All helpers degrade gracefully when stdout isn't a TTY (smokes, CI).
 */

import chalk from "chalk";
import { SingleBar, Presets } from "cli-progress";
import ora, { type Ora } from "ora";

export type DiscoveryStatus = "ok" | "warn" | "err" | "info";

export function icon(status: DiscoveryStatus): string {
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

export function header(title: string): void {
  process.stdout.write(`\n  ${chalk.bold("Cairn")} ${chalk.dim("—")} ${title}\n\n`);
}

export function sectionTitle(label: string): void {
  process.stdout.write(`  ${chalk.bold(label)}\n`);
}

export function blankLine(): void {
  process.stdout.write("\n");
}

export function dimLine(line: string): void {
  process.stdout.write(`  ${chalk.dim(line)}\n`);
}

export function plainLine(line: string): void {
  process.stdout.write(`  ${line}\n`);
}

/** A simple long-task spinner. Returns control object with succeed/fail. */
export interface SpinnerHandle {
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
  return {
    succeed: (final) => spinner.succeed(final),
    fail: (final) => spinner.fail(final),
    update: (next) => {
      spinner.text = next;
    },
    stop: () => spinner.stop(),
  };
}

/** Long-task wrapper: spinner + result. Spinner shows duration on success. */
export async function withSpinner<T>(
  startText: string,
  task: () => Promise<T>,
  opts: {
    /** Custom message on success (default: derived from elapsed). */
    successText?: (result: T, durationMs: number) => string;
    /** Custom message on failure (default: error message). */
    failText?: (err: unknown) => string;
  } = {},
): Promise<T> {
  const spinner = startSpinner(startText);
  const t0 = Date.now();
  try {
    const result = await task();
    const ms = Date.now() - t0;
    const text = opts.successText
      ? opts.successText(result, ms)
      : `${startText.replace(/\.+$/, "")} (${formatDuration(ms)})`;
    spinner.succeed(text);
    return result;
  } catch (err) {
    const text = opts.failText
      ? opts.failText(err)
      : err instanceof Error
        ? err.message
        : String(err);
    spinner.fail(text);
    throw err;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

/** Progress-bar handle for byte-counted downloads. */
export interface ProgressHandle {
  set(current: number, payload?: Record<string, unknown>): void;
  stop(success: boolean, finalLabel?: string): void;
}

export function startProgress(opts: {
  label: string;
  total: number;
}): ProgressHandle {
  const tty = process.stdout.isTTY === true;
  if (!tty) {
    process.stdout.write(`  ${opts.label}…\n`);
    return {
      set: () => {
        // no-op in non-TTY
      },
      stop: (success, finalLabel) => {
        if (finalLabel !== undefined) {
          process.stdout.write(
            `  ${icon(success ? "ok" : "err")}  ${finalLabel}\n`,
          );
        }
      },
    };
  }
  process.stdout.write(`  ${opts.label}\n`);
  const bar = new SingleBar(
    {
      format: `  {bar} {percentage}%  {valueMb}MB / {totalMb}MB  {speedMb}MB/s`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
    },
    Presets.shades_classic,
  );
  bar.start(opts.total, 0, {
    valueMb: "0",
    totalMb: bytesToMb(opts.total),
    speedMb: "0.0",
  });
  return {
    set: (current, payload) => {
      bar.update(current, {
        valueMb: bytesToMb(current),
        totalMb: bytesToMb(opts.total),
        speedMb:
          payload !== undefined && typeof payload["speedMb"] === "string"
            ? payload["speedMb"]
            : "—",
      });
    },
    stop: (success, finalLabel) => {
      bar.stop();
      if (finalLabel !== undefined) {
        process.stdout.write(
          `  ${icon(success ? "ok" : "err")}  ${finalLabel}\n`,
        );
      }
    },
  };
}

function bytesToMb(b: number): string {
  return (b / 1_048_576).toFixed(0);
}

export const c = {
  bold: (s: string): string => chalk.bold(s),
  dim: (s: string): string => chalk.dim(s),
  green: (s: string): string => chalk.green(s),
  yellow: (s: string): string => chalk.yellow(s),
  red: (s: string): string => chalk.red(s),
  cyan: (s: string): string => chalk.cyan(s),
};
