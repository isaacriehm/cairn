/**
 * Cairn Lens debug log — console-mirrored sink that forwards to a
 * VS Code LogOutputChannel when one is attached. The channel is
 * created and attached by `src/extension.ts` (the only module that
 * may import `vscode` statically); this module stays pure-Node so
 * the resolver smokes (`scripts/smoke-resolver.ts`) can pull
 * `dist/resolver.js` in without dragging `vscode` into the graph.
 *
 * Operator surface:
 *   View → Output → "Cairn Lens" — use the level dropdown to crank
 *   verbosity. The `cairn-lens.showLog` command opens the panel
 *   directly; the status bar item also routes there on click.
 *
 * Uses `LogOutputChannel` for the level dropdown in the Output panel.
 */

type LensLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LensLogChannel {
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
  trace(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

let channel: LensLogChannel | null = null;

/**
 * Attach the LogOutputChannel created by the extension entry point.
 * Idempotent — second calls are ignored so re-activation in the same
 * host process doesn't double-wire.
 */
export function attachLensLogChannel(ch: LensLogChannel): void {
  if (channel !== null) return;
  channel = ch;
}

export function lensLog(message: string, level: LensLogLevel = "info"): void {
  // Console mirror is always-on so Help → Toggle Developer Tools
  // shows the trail even before the OutputChannel has been wired
  // (early activation, smoke runs, etc.).
  // eslint-disable-next-line no-console -- debug surface
  console.log(`[cairn-lens][${level}] ${message}`);
  if (channel === null) return;
  const fn = channel[level];
  if (typeof fn === "function") {
    fn.call(channel, message);
  } else {
    channel.appendLine(`[${level}] ${message}`);
  }
}

export function showLensLog(preserveFocus = false): void {
  channel?.show(preserveFocus);
}
