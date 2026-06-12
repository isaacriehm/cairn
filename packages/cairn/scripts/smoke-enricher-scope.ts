#!/usr/bin/env tsx
/**
 * smoke-enricher-scope — context engine, stage 2.
 *
 * Drives the PostToolUse(Read) enricher (`cairn hook read-enrich`) and
 * asserts the stage-2 behaviour:
 *
 *   A. A cited DEC body is injected on first read, SUPPRESSED on re-read
 *      (per-session seen.json dedup — bodies show once; D13).
 *   B. Reading a file under a component dir injects the component slice
 *      (name · category · purpose), then suppresses it on re-read (D17).
 *   C. A non-component file with no citations injects nothing.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeScopeIndex } from "@isaacriehm/cairn-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CAIRN_BIN = join(REPO_ROOT, "packages", "cairn", "dist", "cli", "index.js");

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function mkRepoRoot(tag: string, components?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-smoke-enricher-${tag}-`));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  // JSON is valid YAML, so config can be written as JSON.
  const config: Record<string, unknown> = { slug: "smoke", cairn_version: "0.3.0" };
  if (components !== undefined) config.components = components;
  writeFileSync(join(dir, ".cairn", "config.yaml"), JSON.stringify(config), "utf8");
  return dir;
}

function readEnrich(
  repoRoot: string,
  sessionId: string,
  filePath: string,
  content: string,
): string {
  mkdirSync(join(repoRoot, ".cairn", "sessions", sessionId), { recursive: true });
  const result = spawnSync("node", [CAIRN_BIN, "hook", "read-enrich"], {
    input: JSON.stringify({
      session_id: sessionId,
      cwd: repoRoot,
      tool_name: "Read",
      tool_input: { file_path: filePath },
      tool_response: { file: { content } },
    }),
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    const out = JSON.parse((result.stdout ?? "").trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return out.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

function componentHeader(name: string, category: string): string {
  return [
    "/**",
    ` * @cairn ${name}`,
    ` * @category ${category}`,
    ` * @purpose ${name} does a thing worth searching for.`,
    ` * @aliases ${name.toLowerCase()}, thing, widget`,
    " */",
    `export function ${name}() { return null; }`,
    "",
  ].join("\n");
}

function main(): void {
  console.log("smoke-enricher-scope — start");
  assert(
    existsSync(CAIRN_BIN),
    `expected compiled cairn CLI at ${CAIRN_BIN} (run pnpm build first)`,
  );

  // ── A — cited DEC body shown once, deduped on re-read ───────────────
  {
    const repo = mkRepoRoot("a");
    const sid = "sess-enricher-a";
    const content = ["// header", "// §DEC-deadbee explicit route file", "const x = 1;", ""].join("\n");
    write(repo, "src/route.ts", content);
    const first = readEnrich(repo, sid, "src/route.ts", content);
    assert(first.includes("deadbee"), "A: first read should inject the cited DEC body");
    const second = readEnrich(repo, sid, "src/route.ts", content);
    assert(
      !second.includes("deadbee"),
      "A: re-read must NOT re-inject the DEC body (seen dedup)",
    );
    console.log("  ✓ A — cited DEC body injected once, suppressed on re-read");
  }

  // ── B — component slice injected for a component-dir read, then once ─
  {
    const repo = mkRepoRoot("b", { componentDirs: ["src/components"], extensions: [".tsx"] });
    const sid = "sess-enricher-b";
    const btn = componentHeader("Button", "forms");
    write(repo, "src/components/Button.tsx", btn);
    const first = readEnrich(repo, sid, "src/components/Button.tsx", btn);
    assert(
      first.includes("components in scope"),
      "B: first read of a component-dir file should inject the component slice",
    );
    assert(first.includes("Button"), "B: slice should name the Button component");
    assert(first.includes("forms"), "B: slice should carry the component category");
    const second = readEnrich(repo, sid, "src/components/Button.tsx", btn);
    assert(
      !second.includes("Button"),
      "B: re-read must NOT re-inject the component slice (seen dedup)",
    );
    console.log("  ✓ B — component slice injected once, suppressed on re-read");
  }

  // ── C — non-component, no-citation file injects nothing ─────────────
  {
    const repo = mkRepoRoot("c", { componentDirs: ["src/components"], extensions: [".tsx"] });
    const sid = "sess-enricher-c";
    const content = "export const y = 2;\n";
    write(repo, "src/util.ts", content);
    const out = readEnrich(repo, sid, "src/util.ts", content);
    assert(out.length === 0, `C: plain file should inject nothing (got ${out.length} chars)`);
    console.log("  ✓ C — non-component, no-citation file injects nothing");
  }

  // ── D — file-scope box (scope-index binding) shows once, then deduped
  {
    const repo = mkRepoRoot("d");
    mkdirSync(join(repo, ".cairn", "ground"), { recursive: true });
    writeScopeIndex(repo, {
      generated: "2026-01-01T00:00:00Z",
      files: { "src/auth/login.ts": { decisions: ["DEC-deadbee"], invariants: [] } },
    });
    const sid = "sess-enricher-d";
    const content = "export const handler = () => {};\n";
    write(repo, "src/auth/login.ts", content);
    const first = readEnrich(repo, sid, "src/auth/login.ts", content);
    assert(first.includes("DEC-deadbee"), "D: first read should inject the file-scope box");
    const second = readEnrich(repo, sid, "src/auth/login.ts", content);
    assert(
      !second.includes("DEC-deadbee"),
      "D: re-read must NOT re-inject the file-scope box (scope dedup)",
    );
    console.log("  ✓ D — file-scope box injected once, suppressed on re-read");
  }

  cleanup();
  console.log("smoke-enricher-scope — pass");
}

main();
