#!/usr/bin/env node
/**
 * build-bundle — esbuild the cairn CLI into a single self-contained
 * dist/cli.cjs that the Claude Code plugin invokes via
 * `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.cjs <subcommand>`.
 *
 * Self-contained = the plugin marketplace clone runs the bundle without
 * any `npm install -g`, npx, or PATH dependency. Replaces the v0.1.x
 * approaches of pointing manifests at sibling workspace packages (broke
 * once Claude Code's plugin cache only stored the plugin dir) and the
 * npx workaround (every-call latency + registry dependency).
 *
 * Two build-time defines collapse cairn-core's import.meta.url-relative
 * filesystem walks into the bundle's flat layout:
 *   __CAIRN_BUNDLED__ = true     → templates resolved beside dist/cli.cjs
 *   __CAIRN_VERSION__ = "<ver>"  → VERSION baked in (no package.json read)
 *
 * After esbuild we also mirror cairn-core/templates/ to dist/templates/
 * so the runtime catalog/seed lookups resolve to a real path.
 */

import { build } from "esbuild";
import { cpSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const CORE_ROOT = resolve(REPO_ROOT, "packages", "cairn-core");

const corePkg = JSON.parse(
  readFileSync(resolve(CORE_ROOT, "package.json"), "utf8"),
);
const VERSION = corePkg.version;

await build({
  entryPoints: [resolve(PKG_ROOT, "src/bundle-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(PKG_ROOT, "dist/cli.mjs"),
  external: ["fsevents"],
  // ESM bundle bridges to CJS deps (pino, simple-git, etc.) via a
  // banner-injected createRequire — esbuild's standard pattern for
  // mixed ESM/CJS Node bundles.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __cairnCreateRequire } from "node:module";',
      "const require = __cairnCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  logLevel: "warning",
  absWorkingDir: PKG_ROOT,
  define: {
    __CAIRN_BUNDLED__: "true",
    __CAIRN_VERSION__: JSON.stringify(VERSION),
  },
});

// Mirror cairn-core/templates/ → plugin/dist/templates/ so cairn-core's
// runtime template lookups resolve under the bundled layout.
const srcTemplates = resolve(CORE_ROOT, "templates");
const dstTemplates = resolve(PKG_ROOT, "dist", "templates");
try {
  statSync(srcTemplates);
} catch {
  console.error(`build-bundle: missing templates dir at ${srcTemplates}`);
  process.exit(1);
}
rmSync(dstTemplates, { recursive: true, force: true });
cpSync(srcTemplates, dstTemplates, { recursive: true });

console.log(`build-bundle: dist/cli.mjs (cairn-core@${VERSION}) + dist/templates/`);
