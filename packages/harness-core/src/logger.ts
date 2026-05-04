import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { pino, type Logger } from "pino";

/**
 * Pino destination indirection. By default pino logs go to a black-hole
 * writable so structured log lines never leak into a CLI's terminal output.
 * Init / daemon / watch flows call `setLogFile(path)` early to redirect to
 * a file. Long-lived background processes (daemon) can call `setLogStderr()`
 * to fall back to stderr.
 *
 * Children created via `logger(module)` write to whichever destination is
 * currently active at the time of the write — child references stay valid
 * across redirection.
 */

let activeDestination: NodeJS.WritableStream = nullStream();

const proxyStream = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    try {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      activeDestination.write(buf, () => callback());
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  },
});

const root: Logger = pino(
  {
    level: process.env["HARNESS_LOG_LEVEL"] ?? "info",
    base: { pid: process.pid },
    redact: {
      paths: [
        "*.token",
        "*.password",
        "*.secret",
        "*.apiKey",
        "*.api_key",
        "headers.authorization",
        "headers.cookie",
      ],
      censor: "[redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  proxyStream,
);

export function logger(module: string): Logger {
  return root.child({ module });
}

export const rootLogger = root;

/**
 * Redirect all subsequent pino output to `absPath`. Creates parent dirs as
 * needed. Returns the path written to. Subsequent calls swap to the new
 * file (the previous stream stays open for whatever Node's GC decides).
 */
export function setLogFile(absPath: string): string {
  mkdirSync(dirname(absPath), { recursive: true });
  const stream: WriteStream = createWriteStream(absPath, {
    flags: "a",
    encoding: "utf8",
  });
  activeDestination = stream;
  return absPath;
}

/** Re-route logger output to stderr. Useful for long-lived daemons. */
export function setLogStderr(): void {
  activeDestination = process.stderr;
}

/** Drop logger output entirely. Used by smokes that don't want noise. */
export function setLogNull(): void {
  activeDestination = nullStream();
}

function nullStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, callback) {
      callback();
    },
  });
}
