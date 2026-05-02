/**
 * ui probe — live Playwright runtime.
 *
 * Lazy-loads `playwright-core` so the harness package install stays fast.
 * Browsers are downloaded separately via `harness setup:uat-browsers`
 * (which wraps `npx playwright install chromium`). When playwright-core
 * is missing OR no chromium binary is installed, the probe returns a
 * structured `skipped_reason` and the UAT pipeline records the AC as
 * `skipped` rather than failing.
 *
 * Captures per-step screenshots, video.webm (when supported), console
 * lines, and network requests. All artifacts land under the run's
 * `.harness/runs/active/<run_id>/uat/probes/<probe_id>/`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";
import type { ProbeRunResult, UiProbe } from "../types.js";

const log = logger("uat.probe.ui");

let cachedPlaywright: PlaywrightLike | null | undefined;

interface PlaywrightLike {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<PwBrowser>;
  };
}

interface PwBrowser {
  newContext(opts?: {
    recordVideo?: { dir: string };
    viewport?: { width: number; height: number };
  }): Promise<PwContext>;
  close(): Promise<void>;
}

interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

interface PwPage {
  goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<Buffer>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(predicate: string, opts?: { timeout?: number }): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  isVisible(selector: string): Promise<boolean>;
  content(): Promise<string>;
  on(event: "console", handler: (msg: { type(): string; text(): string }) => void): void;
  on(
    event: "request",
    handler: (req: {
      method(): string;
      url(): string;
      resourceType(): string;
    }) => void,
  ): void;
  on(
    event: "response",
    handler: (res: { url(): string; status(): number }) => void,
  ): void;
  video(): { path(): Promise<string>; saveAs(target: string): Promise<void> } | null;
}

async function loadPlaywright(): Promise<PlaywrightLike | null> {
  if (cachedPlaywright !== undefined) return cachedPlaywright;
  try {
    const mod = (await import(
      /* @vite-ignore */ "playwright-core" as string
    ).catch(() => null)) as PlaywrightLike | null;
    cachedPlaywright = mod;
    return mod;
  } catch {
    cachedPlaywright = null;
    return null;
  }
}

export async function runUiProbe(args: {
  probe: UiProbe;
  outputDir: string;
}): Promise<ProbeRunResult> {
  const startedAt = Date.now();
  const pw = await loadPlaywright();
  if (!pw || !pw.chromium) {
    return {
      probe_id: args.probe.id,
      probe_kind: "ui",
      passed: false,
      evidence: "playwright-core not installed",
      duration_ms: Date.now() - startedAt,
      skipped_reason:
        "ui probe needs `playwright-core` + chromium. Run `harness setup:uat-browsers` to install both.",
    };
  }

  const probeDir = join(args.outputDir, "probes", args.probe.id);
  await mkdir(probeDir, { recursive: true });
  const screenshotsDir = join(probeDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const consoleLines: string[] = [];
  const networkLines: { method: string; url: string; resourceType?: string; status?: number }[] = [];
  const artifacts: string[] = [];
  let browser: PwBrowser | undefined;
  let page: PwPage | undefined;

  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (err) {
    return {
      probe_id: args.probe.id,
      probe_kind: "ui",
      passed: false,
      evidence: `chromium failed to launch: ${String(err).slice(0, 200)}`,
      duration_ms: Date.now() - startedAt,
      skipped_reason:
        "chromium binary missing — run `harness setup:uat-browsers`",
    };
  }

  const failures: string[] = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: probeDir },
    });
    page = await ctx.newPage();
    page.on("console", (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on("request", (req) => {
      const entry: { method: string; url: string; resourceType?: string } = {
        method: req.method(),
        url: req.url(),
      };
      const rt = req.resourceType();
      if (rt) entry.resourceType = rt;
      networkLines.push(entry);
    });
    page.on("response", (res) => {
      const last = networkLines[networkLines.length - 1];
      if (last && last.url === res.url()) last.status = res.status();
    });

    // Initial baseline screenshot.
    const baseline = join(screenshotsDir, "00-baseline.png");
    try {
      await page.goto(args.probe.url, { timeout: args.probe.timeout_ms ?? 30_000 });
    } catch (err) {
      failures.push(`goto ${args.probe.url} failed: ${String(err).slice(0, 200)}`);
    }
    if (failures.length === 0) {
      await page.screenshot({ path: baseline, fullPage: false });
      artifacts.push(`probes/${args.probe.id}/screenshots/00-baseline.png`);
    }

    // Run steps.
    let stepIdx = 1;
    for (const step of args.probe.steps) {
      try {
        switch (step.action) {
          case "goto":
            if (step.value !== undefined) {
              await page.goto(step.value, { timeout: step.timeout_ms ?? 30_000 });
            } else {
              failures.push(`step ${stepIdx} (goto) missing value`);
            }
            break;
          case "click":
            if (step.selector !== undefined) {
              await page.click(step.selector, { timeout: step.timeout_ms ?? 10_000 });
            } else {
              failures.push(`step ${stepIdx} (click) missing selector`);
            }
            break;
          case "fill":
            if (step.selector !== undefined && step.value !== undefined) {
              await page.fill(step.selector, step.value, { timeout: step.timeout_ms ?? 10_000 });
            } else {
              failures.push(`step ${stepIdx} (fill) missing selector or value`);
            }
            break;
          case "wait_for_selector":
            if (step.selector !== undefined) {
              await page.waitForSelector(step.selector, { timeout: step.timeout_ms ?? 10_000 });
            } else {
              failures.push(`step ${stepIdx} (wait_for_selector) missing selector`);
            }
            break;
          case "wait_for_text":
            if (step.text !== undefined) {
              const predicate = `document.body && document.body.innerText.includes(${JSON.stringify(step.text)})`;
              await page.waitForFunction(predicate, { timeout: step.timeout_ms ?? 10_000 });
            } else {
              failures.push(`step ${stepIdx} (wait_for_text) missing text`);
            }
            break;
          case "screenshot": {
            const name = step.path ?? `${String(stepIdx).padStart(2, "0")}-step.png`;
            const path = join(screenshotsDir, name);
            await page.screenshot({ path, fullPage: false });
            artifacts.push(`probes/${args.probe.id}/screenshots/${name}`);
            break;
          }
        }
      } catch (err) {
        failures.push(`step ${stepIdx} (${step.action}) failed: ${String(err).slice(0, 200)}`);
      }
      stepIdx += 1;
    }

    // Evaluate expectations after steps complete.
    if (failures.length === 0) {
      const html = await page.content();
      if (args.probe.expect.text_present) {
        for (const text of args.probe.expect.text_present) {
          if (!html.includes(text)) {
            failures.push(`expected text not present on page: ${text.slice(0, 60)}`);
          }
        }
      }
      if (args.probe.expect.selector_visible) {
        for (const sel of args.probe.expect.selector_visible) {
          if (!(await page.isVisible(sel))) {
            failures.push(`selector not visible: ${sel}`);
          }
        }
      }
    }

    // Final screenshot for evidence.
    const final = join(screenshotsDir, "99-final.png");
    try {
      await page.screenshot({ path: final, fullPage: false });
      artifacts.push(`probes/${args.probe.id}/screenshots/99-final.png`);
    } catch {
      // best effort
    }

    // Save video if available.
    const video = page.video?.();
    if (video) {
      const target = join(probeDir, "video.webm");
      try {
        await video.saveAs(target);
        artifacts.push(`probes/${args.probe.id}/video.webm`);
      } catch {
        // best effort
      }
    }

    await ctx.close();
  } catch (err) {
    failures.push(`unexpected: ${String(err).slice(0, 200)}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best effort
      }
    }
  }

  // Persist console + network logs.
  const consolePath = join(probeDir, "console.log");
  const networkPath = join(probeDir, "network.json");
  await writeFile(consolePath, consoleLines.join("\n"), "utf8");
  await writeFile(networkPath, JSON.stringify(networkLines, null, 2), "utf8");
  artifacts.push(`probes/${args.probe.id}/console.log`, `probes/${args.probe.id}/network.json`);

  const passed = failures.length === 0;
  log.debug(
    {
      probe_id: args.probe.id,
      passed,
      failures: failures.length,
      console_lines: consoleLines.length,
      network_lines: networkLines.length,
    },
    "ui probe complete",
  );

  return {
    probe_id: args.probe.id,
    probe_kind: "ui",
    passed,
    evidence: `${args.probe.url} → ${artifacts.length} artifact(s); console=${consoleLines.length}; network=${networkLines.length}`,
    duration_ms: Date.now() - startedAt,
    artifacts,
    ...(passed ? {} : { failure_reason: failures.join("; ") }),
  };
}
