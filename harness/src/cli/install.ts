/**
 * `harness install` — register the daemon as a launchd LaunchAgent (macOS).
 *
 * Generates `~/Library/LaunchAgents/com.devplusllc.harness.<slug>.plist`
 * pointing at `harness daemon --project <slug>`, then `launchctl load`s it.
 * After install, the daemon survives reboot, restarts on crash (RunAtLoad
 * + KeepAlive), and tees stdout/stderr into
 * `~/.local/harness/logs/<slug>.supervisor.log`.
 *
 * Subcommands:
 *   install   <slug>            write plist + launchctl load
 *   uninstall <slug>            launchctl unload + remove plist
 *   status    <slug>            launchctl list status + plist path
 *   restart   <slug>            unload + load
 *
 * Linux operators: use systemd unit instead (not bundled here yet — the
 * operator's stated workflow is macOS Claude Code + Discord).
 *
 * Friends adopting the harness via private GitHub install:
 *   npm install github:<you>/harness#<sha>
 *   cd ~/their-app
 *   npx harness init . --force
 *   npx harness install
 *   # done — survives reboot
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeProjectName } from "../mirror/index.js";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.error(
    "Usage: harness install <subcommand> [options]\n" +
      "  install    [--project <slug>] [--frontend <list>] [--no-gc] [--dry-run]\n" +
      "  uninstall  [--project <slug>] [--dry-run]\n" +
      "  status     [--project <slug>]\n" +
      "  restart    [--project <slug>]\n" +
      "\n" +
      "  --project   project slug (default: read .harness/config.yaml in cwd)\n" +
      "  --frontend  adapter list passed to daemon (default: discord)\n" +
      "  --no-gc     disable the daemon's nightly gc tick\n" +
      "  --dry-run   write the plist to a tmp dir + print path; skip launchctl\n" +
      "\n" +
      "macOS only (launchd LaunchAgent). Plist path:\n" +
      "  ~/Library/LaunchAgents/com.devplusllc.harness.<slug>.plist",
  );
  process.exit(1);
}

function readProjectFromCwd(): string | undefined {
  const configPath = resolve(process.cwd(), ".harness", "config.yaml");
  if (!existsSync(configPath)) return undefined;
  try {
    const text = readFileSync(configPath, "utf8");
    const parsed = parseYaml(text) as Record<string, unknown>;
    const slug = parsed["slug"];
    return typeof slug === "string" ? slug : undefined;
  } catch {
    return undefined;
  }
}

interface PlistOptions {
  project: string;
  /** Working directory the daemon runs in — usually the adopted project root. */
  workingDirectory: string;
  /** Adapter list. Default "discord". */
  frontends: string;
  /** When true, pass --no-gc to the daemon. */
  noGc: boolean;
  /** Override log dir. Default ~/.local/harness/logs. */
  logDir: string;
  /** Resolved absolute path to harness CLI script. */
  harnessBin: string;
  /** Node binary path. */
  nodeBin: string;
  /** Override PATH the daemon inherits. Default: process.env.PATH. */
  pathEnv: string;
}

export interface PlistResult {
  label: string;
  plistPath: string;
  /** XML body that was written. */
  body: string;
}

export function buildLaunchdPlist(opts: PlistOptions): PlistResult {
  const label = `com.devplusllc.harness.${opts.project}`;
  const args: string[] = [
    opts.harnessBin,
    "daemon",
    "--project",
    opts.project,
    "--frontend",
    opts.frontends,
    "--log-dir",
    opts.logDir,
  ];
  if (opts.noGc) args.push("--no-gc");
  const stdoutPath = resolve(opts.logDir, `${opts.project}.supervisor.out.log`);
  const stderrPath = resolve(opts.logDir, `${opts.project}.supervisor.err.log`);
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
  );
  lines.push(`<plist version="1.0">`);
  lines.push(`  <dict>`);
  lines.push(`    <key>Label</key>`);
  lines.push(`    <string>${escapeXml(label)}</string>`);
  lines.push(`    <key>ProgramArguments</key>`);
  lines.push(`    <array>`);
  lines.push(`      <string>${escapeXml(opts.nodeBin)}</string>`);
  for (const arg of args) {
    lines.push(`      <string>${escapeXml(arg)}</string>`);
  }
  lines.push(`    </array>`);
  lines.push(`    <key>RunAtLoad</key>`);
  lines.push(`    <true/>`);
  lines.push(`    <key>KeepAlive</key>`);
  lines.push(`    <dict>`);
  lines.push(`      <key>SuccessfulExit</key>`);
  lines.push(`      <false/>`);
  lines.push(`    </dict>`);
  lines.push(`    <key>WorkingDirectory</key>`);
  lines.push(`    <string>${escapeXml(opts.workingDirectory)}</string>`);
  lines.push(`    <key>StandardOutPath</key>`);
  lines.push(`    <string>${escapeXml(stdoutPath)}</string>`);
  lines.push(`    <key>StandardErrorPath</key>`);
  lines.push(`    <string>${escapeXml(stderrPath)}</string>`);
  lines.push(`    <key>EnvironmentVariables</key>`);
  lines.push(`    <dict>`);
  lines.push(`      <key>PATH</key>`);
  lines.push(`      <string>${escapeXml(opts.pathEnv)}</string>`);
  lines.push(`      <key>HOME</key>`);
  lines.push(`      <string>${escapeXml(homedir())}</string>`);
  lines.push(`    </dict>`);
  lines.push(`  </dict>`);
  lines.push(`</plist>`);
  const body = lines.join("\n") + "\n";
  const plistPath = launchdPlistPathFor(label);
  return { label, plistPath, body };
}

export function launchdPlistPathFor(label: string): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function requireMacOs(): void {
  if (platform() !== "darwin") {
    console.error(
      "harness install is macOS-only (launchd). For Linux, use a systemd user unit instead — not bundled yet.",
    );
    process.exit(2);
  }
}

function launchctl(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function resolveProjectFromFlags(flags: ParsedFlags["flags"]): string {
  const slugRaw =
    typeof flags["project"] === "string"
      ? flags["project"]
      : readProjectFromCwd();
  if (slugRaw === undefined || slugRaw.length === 0) {
    console.error(
      "harness install: --project required (no .harness/config.yaml in cwd)",
    );
    process.exit(2);
  }
  return normalizeProjectName(slugRaw);
}

function commonOpts(flags: ParsedFlags["flags"], project: string): PlistOptions {
  const workingDirectory = process.cwd();
  const frontends =
    typeof flags["frontend"] === "string" ? flags["frontend"] : "discord";
  const noGc = flags["no-gc"] === true;
  const logDir =
    typeof flags["log-dir"] === "string"
      ? resolve(flags["log-dir"])
      : resolve(homedir(), ".local", "harness", "logs");
  const harnessBin = resolve(process.argv[1] ?? "");
  const nodeBin = process.execPath;
  const pathEnv =
    typeof process.env["PATH"] === "string"
      ? process.env["PATH"]
      : "/usr/local/bin:/usr/bin:/bin";
  return {
    project,
    workingDirectory,
    frontends,
    noGc,
    logDir,
    harnessBin,
    nodeBin,
    pathEnv,
  };
}

function writePlist(plist: PlistResult, dryRunPath?: string): string {
  const target = dryRunPath ?? plist.plistPath;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, plist.body, "utf8");
  return target;
}

async function doInstall(flags: ParsedFlags["flags"]): Promise<void> {
  const project = resolveProjectFromFlags(flags);
  const dryRun = flags["dry-run"] === true;
  if (!dryRun) requireMacOs();
  const opts = commonOpts(flags, project);
  mkdirSync(opts.logDir, { recursive: true });
  const plist = buildLaunchdPlist(opts);
  if (dryRun) {
    const tmpDir = resolve(process.cwd(), ".harness", "tmp");
    const tmpPath = resolve(tmpDir, `${plist.label}.plist`);
    writePlist(plist, tmpPath);
    process.stdout.write(
      `dry-run: plist written to ${tmpPath}\n  label: ${plist.label}\n  intended path: ${plist.plistPath}\n  Skipping launchctl load.\n`,
    );
    return;
  }
  writePlist(plist);
  // unload first in case a stale one is loaded (idempotency).
  launchctl(["unload", plist.plistPath]);
  const loadResult = launchctl(["load", "-w", plist.plistPath]);
  if (!loadResult.ok) {
    console.error(
      `launchctl load failed:\n  stderr: ${loadResult.stderr.trim()}\n  plist:  ${plist.plistPath}`,
    );
    process.exit(2);
  }
  process.stdout.write(
    `installed launchd agent ${plist.label}\n  plist:  ${plist.plistPath}\n  logs:   ${opts.logDir}/${project}.*.log\n  status: harness install status --project ${project}\n`,
  );
}

async function doUninstall(flags: ParsedFlags["flags"]): Promise<void> {
  const project = resolveProjectFromFlags(flags);
  const dryRun = flags["dry-run"] === true;
  if (!dryRun) requireMacOs();
  const label = `com.devplusllc.harness.${project}`;
  const plistPath = launchdPlistPathFor(label);
  if (dryRun) {
    process.stdout.write(
      `dry-run: would launchctl unload + remove ${plistPath}\n`,
    );
    return;
  }
  if (existsSync(plistPath)) {
    launchctl(["unload", plistPath]);
    try {
      unlinkSync(plistPath);
    } catch (err) {
      console.error(`failed to remove plist: ${String(err)}`);
      process.exit(2);
    }
    process.stdout.write(`uninstalled ${label}\n  removed: ${plistPath}\n`);
  } else {
    process.stdout.write(`no plist at ${plistPath} (already uninstalled?)\n`);
  }
}

function doStatus(flags: ParsedFlags["flags"]): void {
  const project = resolveProjectFromFlags(flags);
  const label = `com.devplusllc.harness.${project}`;
  const plistPath = launchdPlistPathFor(label);
  const exists = existsSync(plistPath);
  const list = launchctl(["list", label]);
  process.stdout.write(
    `label:  ${label}\n` +
      `plist:  ${plistPath} (${exists ? "exists" : "missing"})\n` +
      `launchctl list:\n${list.stdout || list.stderr || "(no entry)"}\n`,
  );
}

async function doRestart(flags: ParsedFlags["flags"]): Promise<void> {
  const project = resolveProjectFromFlags(flags);
  requireMacOs();
  const label = `com.devplusllc.harness.${project}`;
  const plistPath = launchdPlistPathFor(label);
  if (!existsSync(plistPath)) {
    console.error(`harness install: no plist at ${plistPath}`);
    process.exit(2);
  }
  launchctl(["unload", plistPath]);
  const r = launchctl(["load", "-w", plistPath]);
  if (!r.ok) {
    console.error(`launchctl reload failed: ${r.stderr.trim()}`);
    process.exit(2);
  }
  process.stdout.write(`restarted ${label}\n`);
}

export async function installCli(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  if (flags["help"] === true || flags["h"] === true) usage();
  const sub = positional[0];
  switch (sub) {
    case undefined:
    case "install":
      await doInstall(flags);
      return;
    case "uninstall":
      await doUninstall(flags);
      return;
    case "status":
      doStatus(flags);
      return;
    case "restart":
      await doRestart(flags);
      return;
    default:
      console.error(`harness install: unknown subcommand "${sub}"`);
      usage();
  }
}
