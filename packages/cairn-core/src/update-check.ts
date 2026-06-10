/**
 * SessionStart "newer Cairn available" notice.
 *
 * Cairn ships as a Claude Code plugin distributed through a THIRD-PARTY
 * marketplace, where auto-update is OFF by default — so a user can sit on an
 * old plugin (and its bundled `cli.mjs`) indefinitely with no signal. This is
 * the plugin-side analog of `cairn-lens/src/update-check.ts`: one throttled,
 * best-effort check against the npm registry (the published `@isaacriehm/cairn`
 * version is the synced workspace version), surfaced as a one-line SessionStart
 * banner.
 *
 * Contract: NEVER throws into the caller, NEVER blocks the session for more
 * than `FETCH_TIMEOUT_MS`, and hits the network at most once per day per
 * machine (cached in `~/.cairn/update-check.json`). On a cache hit it is pure
 * filesystem — no network. The hot SessionStart path stays fast.
 */

import { get } from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { writeFileSafe } from "@isaacriehm/cairn-state";
import { updateCheckCachePath } from "./paths/index.js";

const NPM_LATEST_URL = "https://registry.npmjs.org/@isaacriehm/cairn/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 1500; // tight — this is the SessionStart hot path
const MAX_BODY_BYTES = 200_000;

interface UpdateCheckCache {
  /** Epoch ms of the last network attempt (success or failure). */
  checkedMs: number;
  /** Last successfully resolved published version, or null. */
  latest: string | null;
}

function readCache(): UpdateCheckCache {
  const p = updateCheckCachePath();
  if (!existsSync(p)) return { checkedMs: 0, latest: null };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<UpdateCheckCache>;
    return {
      checkedMs: typeof parsed.checkedMs === "number" ? parsed.checkedMs : 0,
      latest: typeof parsed.latest === "string" ? parsed.latest : null,
    };
  } catch {
    return { checkedMs: 0, latest: null };
  }
}

function writeCache(cache: UpdateCheckCache): void {
  try {
    writeFileSafe(updateCheckCachePath(), JSON.stringify(cache));
  } catch {
    // best-effort — a failed cache write just means we re-check next session
  }
}

/**
 * Resolve a "newer Cairn available" banner line, or null when up to date /
 * unknown. Hits the network at most once per `CHECK_INTERVAL_MS`; otherwise
 * reads the cached last-known-latest. `now` is injected for testability.
 */
export async function runUpdateCheck(
  currentVersion: string,
  now: number,
): Promise<string | null> {
  const cache = readCache();
  let latest = cache.latest;

  if (now - cache.checkedMs >= CHECK_INTERVAL_MS) {
    const fetched = await fetchLatestVersion();
    // Stamp the attempt regardless of outcome so an offline machine doesn't
    // re-hit the network every session; keep the prior last-known on failure.
    latest = fetched ?? cache.latest;
    writeCache({ checkedMs: now, latest });
  }

  if (latest === null || !isNewer(latest, currentVersion)) return null;
  return (
    `⬡ A newer Cairn is available — v${latest} (you have v${currentVersion}). ` +
    `Update the plugin via \`/plugin\` (third-party plugins don't auto-update by ` +
    `default); the next session migrates \`.cairn/\` forward automatically.`
  );
}

/**
 * GET the npm `latest` dist-tag document and pull `.version`. Resolves to the
 * version string, or null on any failure (timeout, non-200, unparseable,
 * oversized). Never rejects.
 */
function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = get(
      NPM_LATEST_URL,
      { headers: { accept: "application/json" }, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
          if (data.length > MAX_BODY_BYTES) {
            req.destroy();
            done(null);
          }
        });
        res.on("end", () => {
          try {
            const body = JSON.parse(data) as { version?: unknown };
            done(typeof body.version === "string" ? body.version : null);
          } catch {
            done(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.on("error", () => done(null));
  });
}

/**
 * True when `a` is a strictly newer release than `b` on `major.minor.patch`.
 * Pre-release suffixes are ignored. Unparseable input → false (fail closed:
 * never nag on a version we can't read).
 */
export function isNewer(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  }
  return false;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
