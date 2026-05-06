import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { sotBindingsPath } from "./paths.js";
import { SotBindings } from "./schemas.js";

const log = logger("ground.sot-bindings");

/**
 * Sot-bindings is the lookup table that lens + sensors + the alignment
 * hook all consult to resolve a §DEC-<hash> token to its canonical
 * source. The forward index is one DEC → one path. The reverse index is
 * one path → many DECs (supersedes chains share their sot_path).
 */

export function emptySotBindings(): SotBindings {
  return {
    version: 1,
    generated: new Date().toISOString(),
    forward: {},
    reverse: {},
  };
}

export function readSotBindings(repoRoot: string): SotBindings {
  const path = sotBindingsPath(repoRoot);
  if (!existsSync(path)) return emptySotBindings();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = SotBindings.safeParse(parseYaml(raw));
    if (!parsed.success) {
      log.warn(
        { path, error: parsed.error.message },
        "sot-bindings invalid; treating as empty",
      );
      return emptySotBindings();
    }
    return parsed.data;
  } catch (err) {
    log.warn({ path, err }, "sot-bindings read failed; treating as empty");
    return emptySotBindings();
  }
}

export function writeSotBindings(repoRoot: string, bindings: SotBindings): string {
  const path = sotBindingsPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const next: SotBindings = { ...bindings, generated: new Date().toISOString() };
  writeFileSync(path, stringifyYaml(next), "utf8");
  log.debug(
    { path, decs: Object.keys(next.forward).length },
    "wrote sot-bindings",
  );
  return path;
}

export function bindDec(
  bindings: SotBindings,
  decId: string,
  sotPath: string,
): SotBindings {
  const forward = { ...bindings.forward, [decId]: sotPath };
  const reverse = { ...bindings.reverse };
  const existing = reverse[sotPath] ?? [];
  if (!existing.includes(decId)) {
    reverse[sotPath] = [...existing, decId];
  }
  return { ...bindings, forward, reverse };
}

export function unbindDec(bindings: SotBindings, decId: string): SotBindings {
  const sotPath = bindings.forward[decId];
  if (sotPath === undefined) return bindings;
  const forward = { ...bindings.forward };
  delete forward[decId];
  const reverse = { ...bindings.reverse };
  const list = reverse[sotPath] ?? [];
  const filtered = list.filter((id) => id !== decId);
  if (filtered.length === 0) {
    delete reverse[sotPath];
  } else {
    reverse[sotPath] = filtered;
  }
  return { ...bindings, forward, reverse };
}

export function decsForPath(bindings: SotBindings, sotPath: string): string[] {
  return bindings.reverse[sotPath] ?? [];
}

export function pathForDec(bindings: SotBindings, decId: string): string | null {
  return bindings.forward[decId] ?? null;
}
