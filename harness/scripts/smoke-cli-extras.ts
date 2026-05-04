#!/usr/bin/env tsx
/**
 * smoke-cli-extras — `harness task` + `harness install` + plist gen.
 *
 * Three exercises:
 *
 *   1. taskCli drops a kind=task inbox row with body, title, acceptance,
 *      target_path_globs, ship_anyway honored.
 *
 *   2. buildLaunchdPlist returns a well-formed XML body — required keys
 *      present, ProgramArguments include node + harnessBin + daemon args,
 *      special chars in WorkingDirectory get XML-escaped.
 *
 *   3. installCli with --dry-run writes the plist into <cwd>/.harness/tmp/
 *      and skips launchctl. Asserts file exists + body parses.
 *
 * Daemon supervision (live spawn + SIGTERM → clean stop) intentionally
 * out of scope here — too brittle for CI; covered by manual `harness
 * daemon --once` smoke.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { stringify as stringifyYaml } from "yaml";
import { buildLaunchdPlist, installCli } from "../src/cli/install.js";
import { taskCli } from "../src/cli/task.js";
import {
  ensureMirror,
  mirrorPath,
  mirrorRecordPath,
} from "../src/mirror/index.js";

const projectName = `smoke_cli_${Date.now()}`;
const cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-cli-extras FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of [
    mirrorRecordPath(projectName),
    mirrorPath(projectName),
    ...cleanupPaths,
  ]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

async function main(): Promise<void> {
  // ── Setup mirror (taskCli reads its mirror path from the registry).
  header("Step 0: mirror setup");
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-cli-"));
  cleanupPaths.push(root);
  const originBare = join(root, "origin.git");
  const userTree = join(root, "user-tree");
  mkdirSync(originBare);
  execSync("git init --bare -b main", { cwd: originBare });
  mkdirSync(userTree);
  execSync("git init -b main", { cwd: userTree });
  execSync("git config user.email smoke@harness.local", { cwd: userTree });
  execSync("git config user.name smoke", { cwd: userTree });
  // Pre-write .harness/config.yaml so taskCli's cwd-fallback works.
  mkdirSync(join(userTree, ".harness"), { recursive: true });
  writeFileSync(
    join(userTree, ".harness", "config.yaml"),
    stringifyYaml({ slug: projectName }),
    "utf8",
  );
  writeFileSync(join(userTree, "README.md"), "smoke\n");
  execSync("git add -A && git commit -m initial", { cwd: userTree });
  execSync(`git remote add origin ${originBare}`, { cwd: userTree });
  execSync("git push -u origin main", { cwd: userTree });
  const record = await ensureMirror({
    projectName,
    userTreePath: userTree,
    originUrl: originBare,
  });
  const mirror = record.mirrorPath;
  cleanupPaths.push(mirror);
  console.log(`  mirror: ${mirror}`);

  // ── Step 1: taskCli drops inbox row.
  header("Step 1: harness task drops inbox row");
  // Run from the userTree so cwd-fallback resolves project from config.yaml.
  const origCwd = process.cwd();
  process.chdir(userTree);
  try {
    await taskCli([
      "build the X feature",
      "with full validation",
      "--title",
      "build X",
      "--acceptance",
      "must do A",
      "--acceptance",
      "must not do B",
      "--target",
      "core/src/x/**",
      "--ship-anyway",
    ]);
  } finally {
    process.chdir(origCwd);
  }
  const inboxDir = join(mirror, ".harness", "inbox");
  const files = readdirSync(inboxDir).filter(
    (n) => n.endsWith(".json") && n.includes("-cli-task-"),
  );
  assert(files.length === 1, `expected 1 cli-task inbox row, got ${files.length}`);
  const row = JSON.parse(
    readFileSync(join(inboxDir, files[0]!), "utf8"),
  ) as Record<string, unknown>;
  console.log(
    `  inbox row: kind=${row["kind"]} source=${row["source"]} title=${(row as Record<string, unknown>)["title"] as string}`,
  );
  assert(row["kind"] === "task", `kind mismatch: ${row["kind"]}`);
  assert(row["source"] === "cli", `source mismatch: ${row["source"]}`);
  const task = row["task"] as Record<string, unknown>;
  assert(
    typeof task["rawText"] === "string" &&
      (task["rawText"] as string).startsWith("build the X feature"),
    `rawText mismatch: ${JSON.stringify(task["rawText"])}`,
  );
  assert(task["intent"] === "code_task", "intent should be code_task");
  assert(task["authorId"] === "cli", "authorId should be cli");
  assert(row["title"] === "build X", `title mismatch: ${row["title"]}`);
  const acc = row["acceptance_criteria"] as string[];
  assert(
    Array.isArray(acc) &&
      acc.length === 2 &&
      acc[0] === "must do A" &&
      acc[1] === "must not do B",
    `acceptance mismatch: ${JSON.stringify(acc)}`,
  );
  const tg = row["target_path_globs"] as string[];
  assert(
    Array.isArray(tg) && tg[0] === "core/src/x/**",
    `target_path_globs mismatch: ${JSON.stringify(tg)}`,
  );
  assert(row["ship_anyway"] === true, "ship_anyway should be true");
  console.log(`  ✓ inbox row well-formed (${files[0]})`);

  // ── Step 2: buildLaunchdPlist returns well-formed XML.
  header("Step 2: buildLaunchdPlist shape + escaping");
  const plist = buildLaunchdPlist({
    project: projectName,
    workingDirectory: "/Users/test/My Project & Co",
    frontends: "discord",
    noGc: false,
    logDir: "/var/log/harness",
    harnessBin: "/usr/local/bin/harness",
    nodeBin: "/usr/local/bin/node",
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
  });
  console.log(`  label: ${plist.label}`);
  console.log(`  intended path: ${plist.plistPath}`);
  // Required keys present.
  for (const key of [
    "<key>Label</key>",
    "<key>ProgramArguments</key>",
    "<key>RunAtLoad</key>",
    "<key>KeepAlive</key>",
    "<key>WorkingDirectory</key>",
    "<key>StandardOutPath</key>",
    "<key>StandardErrorPath</key>",
    "<key>EnvironmentVariables</key>",
  ]) {
    assert(plist.body.includes(key), `plist missing ${key}`);
  }
  // ProgramArguments include node + harness + daemon args.
  assert(
    plist.body.includes("<string>/usr/local/bin/node</string>"),
    "node bin missing from ProgramArguments",
  );
  assert(
    plist.body.includes("<string>/usr/local/bin/harness</string>"),
    "harness bin missing from ProgramArguments",
  );
  assert(
    plist.body.includes("<string>daemon</string>"),
    "daemon arg missing",
  );
  assert(
    plist.body.includes(`<string>${projectName}</string>`),
    "project slug missing",
  );
  assert(
    plist.body.includes("<string>discord</string>"),
    "frontend arg missing",
  );
  // XML escaping for &.
  assert(
    plist.body.includes("My Project &amp; Co"),
    "ampersand not XML-escaped",
  );
  // Plist DTD declaration.
  assert(
    plist.body.includes(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"`),
    "DOCTYPE missing",
  );
  // Label format.
  assert(
    plist.label === `com.devplusllc.harness.${projectName}`,
    `label format mismatch: ${plist.label}`,
  );
  console.log(`  ✓ plist body well-formed (${plist.body.length} chars)`);

  // ── Step 3: installCli --dry-run writes plist to .harness/tmp/.
  header("Step 3: installCli --dry-run writes plist");
  process.chdir(userTree);
  try {
    await installCli([
      "install",
      "--project",
      projectName,
      "--dry-run",
    ]);
  } finally {
    process.chdir(origCwd);
  }
  const tmpPlistDir = join(userTree, ".harness", "tmp");
  assert(existsSync(tmpPlistDir), `dry-run tmp dir missing: ${tmpPlistDir}`);
  const tmpPlists = readdirSync(tmpPlistDir).filter((n) =>
    n.endsWith(".plist"),
  );
  assert(tmpPlists.length === 1, `expected 1 plist, got ${tmpPlists.length}`);
  const tmpPlistPath = join(tmpPlistDir, tmpPlists[0]!);
  const tmpBody = readFileSync(tmpPlistPath, "utf8");
  assert(
    tmpBody.includes(`<key>Label</key>`) &&
      tmpBody.includes(`com.devplusllc.harness.${projectName}`),
    "dry-run plist missing label",
  );
  console.log(`  ✓ dry-run plist written to ${tmpPlistPath}`);

  header("Cleanup");
  cleanup();
  console.log("\nsmoke-cli-extras: OK");
}

main().catch((err) => {
  console.error("smoke-cli-extras threw:", err);
  cleanup();
  process.exit(1);
});
