#!/usr/bin/env tsx
/**
 * smoke-component-discovery — Stage 2 self-locating component discovery (0.29.0).
 *
 * Committed mode discovers every `@cairn` header in the git-walked tree and
 * attributes it to a workspace by path prefix — `componentDirs` is the
 * attribution + nag scope, NOT the discovery boundary. Asserts:
 *   - a header OUTSIDE every declared componentDir is found (self-locating);
 *   - a header in a brand-new dir is auto-covered (no config edit);
 *   - monorepo attribution by longest componentDir prefix, then workspace root;
 *   - the missing-header nag stays scoped to componentDirs (no repo-wide flood);
 *   - a single-app project with NO componentDirs still discovers headers.
 * Fixtures use neutral placeholder names.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectComponents, loadComponentsConfig } from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const p of cleanups.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-smoke-compdisc-${tag}-`));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  return dir;
}

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function header(name: string, cat: string, purpose: string, aliases: string): string {
  return `/**\n * @cairn ${name}\n * @category ${cat}\n * @purpose ${purpose}\n * @aliases ${aliases}\n */\n`;
}

const unit = (name: string): string =>
  `export function ${name}() {\n  return <div className="${name.toLowerCase()}">${name}</div>;\n}\n`;

const MONO = [
  "version: 1",
  "slug: smoke",
  "components:",
  "  workspaces:",
  "    web:",
  "      componentDirs:",
  "        - apps/web/src/components",
  "        - apps/web/src/widgets",
  "      extensions:",
  "        - .tsx",
  "      categories:",
  "        - forms",
  "    admin:",
  "      componentDirs:",
  "        - apps/admin/src/components",
  "      extensions:",
  "        - .tsx",
  "      categories:",
  "        - forms",
  "",
].join("\n");

const SINGLE = [
  "version: 1",
  "slug: smoke",
  "components:",
  "  extensions:",
  "    - .tsx",
  "  categories:",
  "    - forms",
  "",
].join("\n");

function main(): void {
  console.log("smoke-component-discovery — start");

  // ── Monorepo — self-location, attribution, scoped nag ───────────────
  const mono = mkRepo("mono");
  write(mono, ".cairn/config.yaml", MONO);
  // Headers inside declared componentDirs.
  write(mono, "apps/web/src/components/Button.tsx", header("Button", "forms", "A button.", "btn, cta") + unit("Button"));
  write(mono, "apps/admin/src/components/Panel.tsx", header("Panel", "forms", "A panel.", "panel, box") + unit("Panel"));
  // Header OUTSIDE every componentDir but under web's workspace root
  // (apps/web/src) — self-locating + new-dir auto-cover + root attribution.
  write(mono, "apps/web/src/features/Billing.tsx", header("Billing", "forms", "Billing screen.", "billing, invoice") + unit("Billing"));
  // Header-less unit UNDER a componentDir → missing (header-debt gate).
  write(mono, "apps/web/src/components/Card.tsx", unit("Card"));
  // Header-less unit OUTSIDE every componentDir → discovered-if-headered but
  // NOT nagged (scoped nag).
  write(mono, "apps/web/src/features/Loose.tsx", unit("Loose"));

  const cfg = loadComponentsConfig(mono);
  const r = collectComponents(mono, cfg);
  assert(r.ghost === false, "mono: committed mode");

  const byName = (n: string) => r.components.find((c) => c.tags.cairn === n);
  assert(byName("Button")?.workspace === "web", "Button attributed to web (longest componentDir prefix)");
  assert(byName("Panel")?.workspace === "admin", "Panel attributed to admin");
  const billing = byName("Billing");
  assert(billing !== undefined, "header OUTSIDE componentDirs is discovered (self-locating)");
  assert(billing?.file === "apps/web/src/features/Billing.tsx", "Billing found in a brand-new dir (auto-cover, no config edit)");
  assert(billing?.workspace === "web", "Billing attributed to web by workspace root (apps/web/src common prefix)");
  assert(r.components.length === 3, "exactly the three headered files are collected");

  assert(r.missing.includes("apps/web/src/components/Card.tsx"), "header-less unit UNDER a componentDir is nagged");
  assert(
    !r.missing.includes("apps/web/src/features/Loose.tsx"),
    "header-less unit OUTSIDE componentDirs is NOT nagged (scoped nag — no flood)",
  );
  assert(r.missing.length === 1, "exactly one missing-header nag");
  console.log("  ✓ monorepo: outside-dir header found + attributed by root; nag scoped to componentDirs");

  // ── Single-app, NO componentDirs — discovery still works ────────────
  const single = mkRepo("single");
  write(single, ".cairn/config.yaml", SINGLE);
  write(single, "src/anywhere/Foo.tsx", header("Foo", "forms", "A widget.", "foo, thing") + unit("Foo"));
  write(single, "src/bar/Bar.tsx", unit("Bar")); // header-less, no componentDirs → no nag

  const scfg = loadComponentsConfig(single);
  const sr = collectComponents(single, scfg);
  assert(sr.components.length === 1 && sr.components[0]?.tags.cairn === "Foo", "single-app with NO componentDirs discovers the header");
  assert(sr.components[0]?.workspace === "", "single-app component attributed to the unnamed workspace");
  assert(sr.missing.length === 0, "single-app without componentDirs raises no missing-header flood");
  console.log("  ✓ single-app: discovery works with zero componentDirs; no nag flood");

  cleanup();
  console.log("smoke-component-discovery — pass");
}

main();
