/**
 * Secrets file — `~/.local/harness/.env`.
 *
 * Operator-scoped (not project-scoped) so a single Discord bot powers
 * every adopted project. Init writes here; the CLI's dotenv loader reads
 * here first.
 *
 * Format = standard dotenv (KEY=VALUE per line, # comments). Existing
 * keys are preserved on append; only the named keys get rewritten.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function harnessEnvPath(): string {
  return join(homedir(), ".local", "harness", ".env");
}

export function readHarnessEnv(): Record<string, string> {
  const p = harnessEnvPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf8");
  return parseDotenv(raw);
}

/**
 * Merge `updates` into the on-disk env file, preserving every other key
 * + comments + ordering of unchanged lines. Created with mode 0600 since
 * it carries secrets.
 */
export function upsertHarnessEnv(updates: Record<string, string>): string {
  const p = harnessEnvPath();
  mkdirSync(dirname(p), { recursive: true });
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = existing.length === 0 ? [] : existing.split(/\r?\n/);
  const seen = new Set<string>();

  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && m[1] !== undefined && updates[m[1]] !== undefined) {
      out.push(`${m[1]}=${updates[m[1]]}`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const text = out.join("\n") + "\n";
  writeFileSync(p, text, { encoding: "utf8", mode: 0o600 });
  return p;
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip wrapping quotes — match dotenv behavior.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}
