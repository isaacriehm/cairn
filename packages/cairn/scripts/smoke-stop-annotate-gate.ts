#!/usr/bin/env tsx
/**
 * smoke-stop-annotate-gate — context engine, stage 3 (the capture gate).
 *
 * A headerless component the session touched flows:
 *   touched.json → collectAnnotateAsks (pre-derives export + categories)
 *   → writeAnnotatePending (Stop stash) → UserPromptSubmit injects the
 *   fully-specified ask → pending cleared → debounce (never re-asked).
 *
 * The Stop runner's first-turn warmup gate (birthtime-based) can't be
 * driven deterministically in a fast smoke, so the collect/stash half is
 * exercised in-process; the inject/consume half runs the real UPS hook.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CAIRN_BIN = join(REPO_ROOT, "packages", "cairn", "dist", "cli", "index.js");
const SURFACE_MOD = join(
  REPO_ROOT,
  "packages",
  "cairn-core",
  "dist",
  "hooks",
  "runners",
  "annotate-surface.js",
);
const SESSION_MOD = join(REPO_ROOT, "packages", "cairn-core", "dist", "session", "index.js");

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

function runUps(repoRoot: string, sessionId: string, prompt: string): string {
  const result = spawnSync("node", [CAIRN_BIN, "hook", "user-prompt-submit"], {
    input: JSON.stringify({ session_id: sessionId, cwd: repoRoot, prompt }),
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

async function main(): Promise<void> {
  console.log("smoke-stop-annotate-gate — start");
  assert(existsSync(CAIRN_BIN), `expected compiled cairn CLI at ${CAIRN_BIN} (run pnpm build first)`);
  assert(existsSync(SURFACE_MOD), `expected built annotate-surface at ${SURFACE_MOD}`);

  const { collectAnnotateAsks, writeAnnotatePending } = (await import(SURFACE_MOD)) as {
    collectAnnotateAsks: (
      repoRoot: string,
      sessionId: string,
    ) => Array<{ file: string; export_name: string | null; categories: string[] }>;
    writeAnnotatePending: (repoRoot: string, sessionId: string, asks: unknown[]) => void;
  };
  const { markShownIds } = (await import(SESSION_MOD)) as {
    markShownIds: (repoRoot: string, sessionId: string, ids: string[]) => void;
  };

  const repo = mkdtempSync(join(tmpdir(), "cairn-smoke-stop-annotate-"));
  cleanups.push(repo);
  mkdirSync(join(repo, ".cairn"), { recursive: true });
  writeFileSync(
    join(repo, ".cairn", "config.yaml"),
    JSON.stringify({
      slug: "smoke",
      components: { componentDirs: ["src/components"], extensions: [".tsx"], categories: ["forms", "layout"] },
    }),
    "utf8",
  );
  const file = "src/components/Button.tsx";
  write(repo, file, `export function Button() {\n  return <div className="rounded border p-4" />;\n}\n`);

  const sid = "sess-stop-annotate";
  mkdirSync(join(repo, ".cairn", "sessions", sid), { recursive: true });
  // Seed the session touched-set (what the post-write hook would record).
  writeFileSync(
    join(repo, ".cairn", "sessions", sid, "touched.json"),
    JSON.stringify({ paths: [file] }),
    "utf8",
  );

  // ── collect: headerless touched component is surfaced with pre-derived
  //    export + categories ───────────────────────────────────────────
  const asks = collectAnnotateAsks(repo, sid);
  assert(asks.length === 1, `collect should surface 1 ask (got ${asks.length})`);
  assert(asks[0]!.file === file, "collect ask should name the touched file");
  assert(asks[0]!.export_name === "Button", "collect should pre-derive export_name Button");
  assert(asks[0]!.categories.includes("forms"), "collect should carry the workspace categories");
  console.log("  ✓ collect — headerless touched component → ask with export + categories");

  // ── stash (Stop) + debounce mark ─────────────────────────────────────
  writeAnnotatePending(repo, sid, asks);
  markShownIds(repo, sid, asks.map((a) => `annotate:${a.file}`));
  assert(
    existsSync(join(repo, ".cairn", "sessions", sid, "annotate-pending.json")),
    "stash should write annotate-pending.json",
  );

  // ── inject (UPS) consumes the stash + renders the fully-specified ask ─
  const ctx = runUps(repo, sid, "ok continue");
  assert(ctx.includes("need registering"), "UPS should inject the annotate ask");
  assert(ctx.includes("Button"), "UPS ask should name the component export");
  assert(ctx.includes("cairn_component_annotate"), "UPS ask should carry the tool call");
  assert(
    !existsSync(join(repo, ".cairn", "sessions", sid, "annotate-pending.json")),
    "UPS should consume (delete) the pending file",
  );
  console.log("  ✓ inject — UPS consumes stash + injects the cairn_component_annotate ask");

  // ── debounce: the same component is not re-asked this session ─────────
  const again = collectAnnotateAsks(repo, sid);
  assert(again.length === 0, `debounce: already-surfaced component must not re-ask (got ${again.length})`);
  console.log("  ✓ debounce — surfaced component is not re-asked this session");

  cleanup();
  console.log("smoke-stop-annotate-gate — pass");
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
