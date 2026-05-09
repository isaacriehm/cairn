/** Minimal logger interface for the state package. */
export interface StateLogger {
  debug: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/** No-op logger as default. */
export const nullLogger: StateLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let activeLogger: StateLogger = nullLogger;

/** Set the active logger for the state package. */
export function setStateLogger(l: StateLogger): void {
  activeLogger = l;
}

/** Get the active logger. */
export function getLogger(): StateLogger {
  return activeLogger;
}
