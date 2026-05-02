import { pino, type Logger } from "pino";

const root: Logger = pino({
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
});

export function logger(module: string): Logger {
  return root.child({ module });
}

export const rootLogger = root;
