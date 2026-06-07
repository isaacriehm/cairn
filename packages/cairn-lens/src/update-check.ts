/**
 * Cairn Lens update check.
 *
 * Cairn Lens ships as a `.vsix` (not the VS Code Marketplace), so the
 * editor never auto-updates it. On activation we make one throttled,
 * best-effort check against the npm registry — the whole workspace
 * shares one synced version (`pnpm version:check`), so the umbrella
 * `@isaacriehm/cairn` package's published version IS the latest Lens
 * version. If a newer version exists we surface a single dismissible
 * notification.
 *
 * Contract: this NEVER blocks activation and NEVER throws into the
 * caller. Network failures are logged and swallowed. The check runs at
 * most once per day, and a dismissed version is not re-surfaced.
 */

import { get } from "node:https";
import * as vscode from "vscode";
import { lensLog } from "./debug-log.js";

/** Synced-version source of truth — the published umbrella package. */
const NPM_LATEST_URL = "https://registry.npmjs.org/@isaacriehm/cairn/latest";
/** Where "Release notes" sends the operator. */
const RELEASES_URL = "https://github.com/isaacriehm/cairn/releases";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 200_000;

const LAST_CHECK_KEY = "cairn-lens.update.lastCheckMs";
const DISMISSED_KEY = "cairn-lens.update.dismissedVersion";

/**
 * Fire the throttled update check without awaiting it — call once from
 * `activate()`. Gated by the `cairn.lens.checkForUpdates` setting and a
 * 24h throttle stored in `globalState`.
 */
export function scheduleUpdateCheck(
  context: vscode.ExtensionContext,
  currentVersion: string,
): void {
  const enabled = vscode.workspace
    .getConfiguration("cairn")
    .get<boolean>("lens.checkForUpdates");
  if (enabled === false) {
    lensLog("update-check: disabled via cairn.lens.checkForUpdates");
    return;
  }
  const last = context.globalState.get<number>(LAST_CHECK_KEY) ?? 0;
  const now = Date.now();
  if (now - last < CHECK_INTERVAL_MS) {
    lensLog("update-check: throttled (checked < 24h ago)");
    return;
  }
  // Fire-and-forget. Any failure is contained inside runUpdateCheck.
  void runUpdateCheck(context, currentVersion, now);
}

async function runUpdateCheck(
  context: vscode.ExtensionContext,
  currentVersion: string,
  now: number,
): Promise<void> {
  const latest = await fetchLatestVersion();
  // Stamp the attempt regardless of outcome so an offline editor
  // doesn't re-hit the network on every window reload.
  await context.globalState.update(LAST_CHECK_KEY, now);
  if (latest === null) {
    lensLog("update-check: no version resolved (offline or registry error)");
    return;
  }
  if (!isNewer(latest, currentVersion)) {
    lensLog(`update-check: up to date (v${currentVersion}, latest v${latest})`);
    return;
  }
  const dismissed = context.globalState.get<string>(DISMISSED_KEY);
  if (dismissed === latest) {
    lensLog(`update-check: v${latest} available but previously dismissed`);
    return;
  }
  lensLog(`update-check: v${latest} available (installed v${currentVersion})`);
  const pick = await vscode.window.showInformationMessage(
    `Cairn Lens v${latest} is available — you have v${currentVersion}. ` +
      "Update your .vsix to pick up the latest.",
    "Release notes",
    "Dismiss",
  );
  if (pick === "Release notes") {
    void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
  } else if (pick === "Dismiss") {
    await context.globalState.update(DISMISSED_KEY, latest);
  }
}

/**
 * GET the npm `latest` dist-tag document and pull `.version`. Resolves
 * to the version string, or `null` on any failure (timeout, non-200,
 * unparseable, oversized). Never rejects.
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
 * True when `a` is a strictly newer release than `b` on
 * `major.minor.patch`. Pre-release suffixes are ignored (a `-rc` build
 * never out-ranks the same release). Unparseable input → `false` (fail
 * closed: never nag on a version we can't read).
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
