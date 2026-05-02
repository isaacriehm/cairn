#!/usr/bin/env tsx
/**
 * setup:uat-docker — sanity-check `docker compose --version` and write
 * a default compose template for integration probes.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

function args(): { repoRoot: string; force: boolean } {
  const argv = process.argv.slice(2);
  let repoRoot = process.cwd();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--repo-root" && argv[i + 1]) {
      const next = argv[i + 1];
      if (next !== undefined) repoRoot = next;
      i += 1;
    } else if (a === "--force") {
      force = true;
    }
  }
  return { repoRoot, force };
}

const DEFAULT_COMPOSE = [
  "# .harness/config/probes/docker-compose.yml — integration-probe template.",
  "# Each service can be referenced by name from an IntegrationProbe.",
  "# Replace this with the project's actual compose, or import the project's",
  "# top-level compose via `extends:`.",
  "",
  "version: '3.9'",
  "services:",
  "  api:",
  "    image: nginx:alpine",
  "    ports:",
  "      - '8080:80'",
  "",
].join("\n");

function main(): number {
  const { repoRoot, force } = args();

  console.log("checking `docker compose --version`…");
  const result = spawnSync("docker", ["compose", "--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(
      "docker compose not on PATH — install Docker Desktop or `brew install --cask docker` first",
    );
    return 1;
  }
  console.log(`  ${result.stdout.trim()}`);

  const path = join(repoRoot, ".harness", "config", "probes", "docker-compose.yml");
  if (existsSync(path) && !force) {
    console.log(`compose template already at ${path} (use --force to overwrite)`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_COMPOSE, "utf8");
    console.log(`wrote ${path}`);
  }

  console.log("\nsetup-uat-docker: OK");
  return 0;
}

process.exit(main());
