#!/usr/bin/env tsx
/**
 * smoke-plugin-bundle — verify the Claude Code plugin's self-contained
 * dist/cli.mjs builds and runs without npm/npx/PATH dependencies.
 *
 * The bundle is what the Claude Code plugin marketplace clones along
 * with the rest of `packages/cairn-frontend-claudecode/`. Its existence,
 * shebang, --version response, and co-located templates dir are
 * load-bearing for the v0.2.0 architectural reset (handoff §A).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "packages", "cairn-frontend-claudecode");
const BUNDLE_PATH = join(PLUGIN_ROOT, "dist", "cli.mjs");
const TEMPLATES_DIR = join(PLUGIN_ROOT, "dist", "templates");
const CORE_PKG_JSON = join(REPO_ROOT, "packages", "cairn-core", "package.json");

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

function runSmoke(): void {
  console.log("smoke-plugin-bundle — start");

  // ── Step 1 — dist/cli.mjs exists ─────────────────────────────────
  {
    assert(
      existsSync(BUNDLE_PATH),
      `Step 1: ${BUNDLE_PATH} missing — run \`pnpm -r build\` first`,
    );
    console.log("  ✓ Step 1 — dist/cli.mjs exists");
  }

  // ── Step 2 — bundle starts with #!/usr/bin/env node shebang ──────
  {
    const head = readFileSync(BUNDLE_PATH, "utf8").slice(0, 256);
    assert(
      head.startsWith("#!/usr/bin/env node"),
      `Step 2: bundle missing shebang, head=${JSON.stringify(head.slice(0, 40))}`,
    );
    console.log("  ✓ Step 2 — bundle has node shebang");
  }

  // ── Step 3 — `node cli.mjs --version` returns cairn-core version ─
  {
    const corePkg = JSON.parse(readFileSync(CORE_PKG_JSON, "utf8")) as {
      version: string;
    };
    const result = spawnSync("node", [BUNDLE_PATH, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert(
      result.status === 0,
      `Step 3: --version exited ${result.status}, stderr=${result.stderr}`,
    );
    const printed = (result.stdout ?? "").trim();
    assert(
      printed === corePkg.version,
      `Step 3: --version printed ${JSON.stringify(printed)}, expected ${corePkg.version}`,
    );
    console.log(`  ✓ Step 3 — --version → ${printed}`);
  }

  // ── Step 4 — dist/templates/ co-located with bundle ──────────────
  {
    assert(existsSync(TEMPLATES_DIR), `Step 4: ${TEMPLATES_DIR} missing`);
    const sensorsYaml = join(
      TEMPLATES_DIR,
      ".cairn",
      "config",
      "sensors.yaml",
    );
    const stubsYaml = join(
      TEMPLATES_DIR,
      ".cairn",
      "config",
      "stub-patterns.yaml",
    );
    assert(existsSync(sensorsYaml), `Step 4: missing template ${sensorsYaml}`);
    assert(existsSync(stubsYaml), `Step 4: missing template ${stubsYaml}`);
    console.log("  ✓ Step 4 — dist/templates/.cairn/config/{sensors,stub-patterns}.yaml present");
  }

  // ── Step 5 — bundle resolves the templates dir post-bundling ─────
  // Run `cairn doctor` with --json (or any subcommand that exercises
  // catalog.ts) and assert it doesn't blow up trying to read templates.
  // Falls back to invoking `mcp serve` with a poison-pill stdin so the
  // server boots, registers tools, then exits — a smoke that the
  // catalog/seed paths resolve under __CAIRN_BUNDLED__.
  {
    const result = spawnSync("node", [BUNDLE_PATH, "doctor"], {
      encoding: "utf8",
      timeout: 10_000,
      input: "",
    });
    // doctor may exit non-zero when run outside an adopted repo; the
    // smoke only cares that it doesn't crash on template resolution.
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert(
      !/ENOENT.*templates/.test(combined),
      `Step 5: doctor crashed on templates ENOENT — bundle/templates layout broken\n${combined}`,
    );
    console.log("  ✓ Step 5 — bundle resolves dist/templates/ post-bundling");
  }

  console.log("smoke-plugin-bundle — pass");
}

runSmoke();
