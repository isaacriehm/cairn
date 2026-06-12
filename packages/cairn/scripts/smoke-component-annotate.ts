#!/usr/bin/env tsx
/**
 * smoke-component-annotate — context engine, stage 3 (the write tool).
 *
 * Exercises `cairn_component_annotate` in committed mode:
 *   A. Valid call → canonical `@cairn` header written above the export +
 *      registry rebuilt.
 *   B. Wrong category (not in the workspace enum) → rejected, file untouched.
 *   C. export_name not a real export → rejected, file untouched.
 *   D. Re-annotate an already-headered file → no-op (no double header).
 *
 * Ghost-mode routing (delegates to cairn_component_register) is covered
 * by the ghost smokes — exercising it here would write to the operator's
 * real ghost registry home, so it is intentionally out of scope.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TOOL_MOD = join(
  REPO_ROOT,
  "packages",
  "cairn-core",
  "dist",
  "mcp",
  "tools",
  "component-annotate.js",
);

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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-annotate-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(
    join(dir, ".cairn", "config.yaml"),
    JSON.stringify({
      slug: "smoke",
      components: {
        componentDirs: ["src/components"],
        extensions: [".tsx"],
        categories: ["forms", "layout"],
      },
    }),
    "utf8",
  );
  return dir;
}

function comp(name: string): string {
  return `export function ${name}() {\n  return <div className="rounded border p-4" />;\n}\n`;
}

function isErr(r: unknown): r is { error: { code: string; message: string } } {
  return typeof r === "object" && r !== null && "error" in r;
}

async function main(): Promise<void> {
  console.log("smoke-component-annotate — start");
  assert(existsSync(TOOL_MOD), `expected built tool at ${TOOL_MOD} (run pnpm build first)`);
  const { componentAnnotateTool } = (await import(TOOL_MOD)) as {
    componentAnnotateTool: {
      handler: (ctx: { repoRoot: string }, input: Record<string, unknown>) => Promise<unknown>;
    };
  };
  const repo = mkRepo();
  const ctx = { repoRoot: repo };

  // ── A — valid annotate writes the canonical header ──────────────────
  {
    write(repo, "src/components/Button.tsx", comp("Button"));
    const res = await componentAnnotateTool.handler(ctx, {
      file: "src/components/Button.tsx",
      export_name: "Button",
      category: "forms",
      purpose: "Primary call-to-action button",
      aliases: ["cta button", "submit button"],
      public_props: ["variant", "size"],
    });
    assert(!isErr(res), `A: valid annotate should succeed (got ${JSON.stringify(res)})`);
    assert(
      (res as { header_written?: boolean }).header_written === true,
      "A: result should report header_written",
    );
    const text = readFileSync(join(repo, "src/components/Button.tsx"), "utf8");
    assert(text.includes("@cairn Button"), "A: file should carry @cairn Button");
    assert(text.includes("@category forms"), "A: file should carry @category forms");
    assert(text.includes("@props variant, size"), "A: file should carry derived @props");
    assert(
      text.indexOf("@cairn") < text.indexOf("export function Button"),
      "A: header must sit above the export",
    );
    console.log("  ✓ A — valid annotate writes the canonical @cairn header");
  }

  // ── B — wrong category rejected, file untouched ─────────────────────
  {
    write(repo, "src/components/Card.tsx", comp("Card"));
    const res = await componentAnnotateTool.handler(ctx, {
      file: "src/components/Card.tsx",
      export_name: "Card",
      category: "bogus",
      purpose: "A content card",
      aliases: ["card", "panel"],
    });
    assert(isErr(res), "B: wrong category should be rejected");
    assert(
      (res as { error: { code: string } }).error.code === "VALIDATION_FAILED",
      "B: rejection code should be VALIDATION_FAILED",
    );
    const text = readFileSync(join(repo, "src/components/Card.tsx"), "utf8");
    assert(!text.includes("@cairn"), "B: rejected file must NOT be modified");
    console.log("  ✓ B — wrong category rejected, file untouched");
  }

  // ── C — export mismatch rejected, file untouched ────────────────────
  {
    const res = await componentAnnotateTool.handler(ctx, {
      file: "src/components/Card.tsx",
      export_name: "NotARealExport",
      category: "forms",
      purpose: "A content card",
      aliases: ["card", "panel"],
    });
    assert(isErr(res), "C: export mismatch should be rejected");
    assert(
      (res as { error: { code: string } }).error.code === "VALIDATION_FAILED",
      "C: rejection code should be VALIDATION_FAILED",
    );
    const text = readFileSync(join(repo, "src/components/Card.tsx"), "utf8");
    assert(!text.includes("@cairn"), "C: rejected file must NOT be modified");
    console.log("  ✓ C — export mismatch rejected, file untouched");
  }

  // ── D — re-annotate an already-headered file is a no-op ─────────────
  {
    const res = await componentAnnotateTool.handler(ctx, {
      file: "src/components/Button.tsx",
      export_name: "Button",
      category: "layout",
      purpose: "Trying to double-write",
      aliases: ["x", "y"],
    });
    assert(!isErr(res), "D: re-annotate should not error");
    assert(
      (res as { already_headered?: boolean }).already_headered === true,
      "D: re-annotate should report already_headered",
    );
    const text = readFileSync(join(repo, "src/components/Button.tsx"), "utf8");
    const count = text.split("@cairn").length - 1;
    assert(count === 1, `D: file must carry exactly one @cairn header (got ${count})`);
    console.log("  ✓ D — re-annotate already-headered file is a no-op");
  }

  // ── E — header inserts BELOW a "use client" directive ───────────────
  {
    write(
      repo,
      "src/components/Modal.tsx",
      `"use client";\n\nexport function Modal() {\n  return <div className="fixed inset-0" />;\n}\n`,
    );
    const res = await componentAnnotateTool.handler(ctx, {
      file: "src/components/Modal.tsx",
      export_name: "Modal",
      category: "layout",
      purpose: "Overlay modal",
      aliases: ["modal", "dialog"],
    });
    assert(!isErr(res), `E: annotate should succeed (got ${JSON.stringify(res)})`);
    const text = readFileSync(join(repo, "src/components/Modal.tsx"), "utf8");
    assert(
      text.startsWith('"use client";'),
      "E: the use-client directive must stay the first line",
    );
    assert(
      text.indexOf('"use client"') < text.indexOf("@cairn"),
      "E: header must sit BELOW the directive",
    );
    assert(
      text.indexOf("@cairn") < text.indexOf("export function Modal"),
      "E: header must sit above the export",
    );
    console.log('  ✓ E — header inserts below a "use client" directive');
  }

  cleanup();
  console.log("smoke-component-annotate — pass");
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
