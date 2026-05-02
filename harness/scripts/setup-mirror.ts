#!/usr/bin/env tsx
/**
 * setup-mirror — adoption-time helper.
 *
 * Run from inside the project's working tree. Detects origin via
 * `git remote get-url origin`, derives the project slug from package.json
 * (or directory name as fallback), and clones the parallel mirror under
 * ~/.local/harness/repos/<slug>/.
 *
 * Idempotent: re-running on an already-adopted project no-ops.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { ensureMirror, normalizeProjectName } from "../src/mirror/index.js";

interface PackageJson {
  name?: string;
}

async function main(): Promise<void> {
  const userTreePath = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

  if (!existsSync(resolve(userTreePath, ".git"))) {
    console.error(`Not a git repository: ${userTreePath}`);
    process.exit(1);
  }

  const pkgPath = resolve(userTreePath, "package.json");
  let rawName = basename(userTreePath);
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    if (typeof pkg.name === "string" && pkg.name.length > 0) {
      rawName = pkg.name;
    }
  }
  const projectName = normalizeProjectName(rawName);

  const git = simpleGit(userTreePath);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin?.refs?.fetch) {
    console.error(`No 'origin' remote in ${userTreePath}.`);
    process.exit(1);
  }
  const originUrl = origin.refs.fetch;

  const record = await ensureMirror({ projectName, originUrl, userTreePath });
  console.log(JSON.stringify(record, null, 2));
}

await main();
