#!/usr/bin/env tsx
/**
 * setup:uat-sql — provision sqlite (default) or stub for pg/mysql.
 *
 * Behavior:
 *   1. Writes a default `.harness/config/probes/sql.yaml` if missing —
 *      one connection key `default` pointing at `:memory:`.
 *   2. Prints next-step guidance: pnpm add -D better-sqlite3 (sqlite),
 *      pg (postgres, Phase 11.5b), mysql2 (mysql, Phase 11.5b).
 *   3. With `--build-binding` AND the sqlite driver, builds the
 *      `better-sqlite3` native binding using the same path-with-spaces
 *      workaround as setup-whisper (stage in /tmp, build, copy back).
 *
 * Idempotent — re-running won't overwrite an existing config (use
 * `--force` to do so).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

function args(): {
  repoRoot: string;
  force: boolean;
  driver: "sqlite" | "postgres" | "mysql";
  buildBinding: boolean;
  install: boolean;
} {
  const argv = process.argv.slice(2);
  let repoRoot = process.cwd();
  let force = false;
  let driver: "sqlite" | "postgres" | "mysql" = "sqlite";
  let buildBinding = false;
  let install = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--repo-root" && argv[i + 1]) {
      const next = argv[i + 1];
      if (next !== undefined) repoRoot = next;
      i += 1;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--driver" && argv[i + 1]) {
      const v = argv[i + 1];
      if (v === "sqlite" || v === "postgres" || v === "mysql") {
        driver = v;
      }
      i += 1;
    } else if (a === "--build-binding") {
      buildBinding = true;
    } else if (a === "--install") {
      install = true;
    }
  }
  return { repoRoot, force, driver, buildBinding, install };
}

const DEFAULT_CONFIG: Record<"sqlite" | "postgres" | "mysql", string> = {
  sqlite: [
    "# .harness/config/probes/sql.yaml — provisioned by `harness setup:uat-sql`.",
    "#",
    "# Each top-level key under `connections:` is the value SqlProbe.connection",
    "# refers to. Probes that target a missing connection are recorded as",
    "# `skipped` rather than failed.",
    "",
    "connections:",
    "  default:",
    "    driver: sqlite",
    "    file: \":memory:\"",
    "    # For a persistent DB, change `:memory:` to e.g. `/tmp/test.db` or",
    "    # `<repo>/test.sqlite`. The probe runner opens read-only by default.",
    "",
  ].join("\n"),
  postgres: [
    "# .harness/config/probes/sql.yaml — provisioned by `harness setup:uat-sql`.",
    "# The postgres driver lands in Phase 11.5b. This template is here so",
    "# you can pre-populate the connection config; running a postgres probe",
    "# before the driver lands returns a structured 'not yet implemented'",
    "# message.",
    "",
    "connections:",
    "  default:",
    "    driver: postgres",
    "    host: localhost",
    "    port: 5432",
    "    database: app",
    "    user_env: PGUSER",
    "    password_env: PGPASSWORD",
    "",
  ].join("\n"),
  mysql: [
    "# .harness/config/probes/sql.yaml — provisioned by `harness setup:uat-sql`.",
    "# The mysql driver lands in Phase 11.5b.",
    "",
    "connections:",
    "  default:",
    "    driver: mysql",
    "    host: localhost",
    "    port: 3306",
    "    database: app",
    "    user_env: MYSQL_USER",
    "    password_env: MYSQL_PASSWORD",
    "",
  ].join("\n"),
};

function buildBetterSqlite3Binding(repoRoot: string): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, "..");
  const requireFn = createRequire(import.meta.url);

  let bsRoot: string;
  try {
    const entry = requireFn.resolve("better-sqlite3", { paths: [pkgRoot, repoRoot] });
    bsRoot = resolve(dirname(entry), "..");
  } catch {
    console.log("  better-sqlite3 not in node_modules — install it first: pnpm add -D better-sqlite3");
    return false;
  }
  const bindingPath = join(bsRoot, "build", "Release", "better_sqlite3.node");
  if (existsSync(bindingPath)) {
    console.log(`  binding already built at ${bindingPath}`);
    return true;
  }

  console.log(`  staging better-sqlite3 in /tmp (path-with-spaces workaround)`);
  const stage = mkdtempSync(join(tmpdir(), "harness-bs3-"));
  try {
    const stageBs = join(stage, "better-sqlite3");
    cpSync(bsRoot, stageBs, {
      recursive: true,
      dereference: true,
      filter: (src) => !src.includes(`${bsRoot}/build/`),
    });
    // node-gyp will look up node-addon-api inside the package's node_modules.
    // Stage that dependency too if better-sqlite3 declares it.
    const addonApiPathCandidate = (() => {
      try {
        return requireFn.resolve("bindings/package.json", { paths: [bsRoot] });
      } catch {
        return null;
      }
    })();
    if (addonApiPathCandidate) {
      const bindingsRoot = dirname(addonApiPathCandidate);
      cpSync(bindingsRoot, join(stageBs, "node_modules", "bindings"), {
        recursive: true,
        dereference: true,
      });
    }

    const build = spawnSync("pnpx", ["node-gyp", "rebuild"], {
      cwd: stageBs,
      stdio: "inherit",
    });
    if (build.status !== 0) {
      console.error(`  node-gyp rebuild exited ${build.status}`);
      return false;
    }

    rmSync(join(bsRoot, "build"), { recursive: true, force: true });
    cpSync(join(stageBs, "build"), join(bsRoot, "build"), { recursive: true });
    if (!existsSync(bindingPath)) {
      console.error(`  expected ${bindingPath} after rebuild`);
      return false;
    }
    console.log(`  built ${bindingPath}`);
    return true;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function installDriverPackage(repoRoot: string, driver: "sqlite" | "postgres" | "mysql"): boolean {
  const pkgs: Record<typeof driver, string[]> = {
    sqlite: ["better-sqlite3", "@types/better-sqlite3"],
    postgres: ["pg", "@types/pg"],
    mysql: ["mysql2"],
  };
  const target = pkgs[driver];
  console.log(`installing ${target.join(" + ")} as devDeps in ${repoRoot}…`);
  const result = spawnSync("pnpm", ["add", "-D", ...target], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`  pnpm add exited ${result.status}`);
    return false;
  }
  return true;
}

function main(): number {
  const { repoRoot, force, driver, buildBinding, install } = args();
  const path = join(repoRoot, ".harness", "config", "probes", "sql.yaml");
  if (existsSync(path) && !force) {
    console.log(`sql config already at ${path} (use --force to overwrite)`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_CONFIG[driver], "utf8");
    console.log(`wrote ${path} (driver=${driver})`);
  }

  if (install) {
    console.log("");
    const ok = installDriverPackage(repoRoot, driver);
    if (!ok) {
      console.log("\nsetup-uat-sql: pnpm add failed — install the driver manually");
      return 1;
    }
  }

  if (buildBinding && driver === "sqlite") {
    console.log("\nbuilding better-sqlite3 native binding…");
    const ok = buildBetterSqlite3Binding(repoRoot);
    if (!ok) {
      console.log("\nsetup-uat-sql: native binding NOT built — re-run with --build-binding once better-sqlite3 is installed");
      return 1;
    }
  }

  console.log("");
  console.log("next steps:");
  if (driver === "sqlite") {
    if (!install) console.log("  pnpm add -D better-sqlite3       # or re-run with --install");
    if (!buildBinding) {
      console.log("  pnpm -F @devplusllc/harness setup:uat-sql --build-binding");
    }
    console.log("  pnpm -F @devplusllc/harness smoke:uat   # exercises sqlite when binding is built");
  } else if (driver === "postgres") {
    if (!install) console.log("  pnpm add -D pg @types/pg         # or re-run with --install");
    console.log("  set PGUSER + PGPASSWORD env vars to match your sql.yaml connection");
    console.log("  the pg driver opens BEGIN TRANSACTION READ ONLY and ROLLBACKs every probe");
  } else if (driver === "mysql") {
    if (!install) console.log("  pnpm add -D mysql2               # or re-run with --install");
    console.log("  set MYSQL_USER + MYSQL_PASSWORD env vars to match your sql.yaml connection");
    console.log("  the mysql driver issues SET SESSION TRANSACTION READ ONLY before each probe");
  }
  console.log("\nsetup-uat-sql: OK");
  return 0;
}

process.exit(main());
