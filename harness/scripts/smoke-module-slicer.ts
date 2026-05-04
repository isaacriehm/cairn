#!/usr/bin/env tsx
/**
 * smoke-module-slicer — synthetic two-module repo, verify slicer output.
 *
 * Pure-mechanical, no LLM. Asserts:
 *   1. Two modules detected from a workspace package.json `workspaces` array
 *      pointing at packages/* (apps/api + apps/web).
 *   2. Each ModuleSlice has the expected moduleSlug + non-null packageJson.
 *   3. Representative-file picker chooses the entry-point + a controller-or-
 *      service file when present.
 *   4. localDocs is populated for the module that has a README.md.
 *   5. Single-package fixture (no workspace, no .gitmodules, no top-level
 *      package.json children) returns one slice rooted at the repo.
 */

import {
  execFileSync,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sliceModules } from "@devplusllc/harness-core";

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

function mkFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `harness-smoke-${name}-`));
  cleanups.push(dir);
  // make it a real git repo so the slicer's git-aware path is exercised
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@harness.test"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "smoke"], { cwd: dir });
  return dir;
}

function writeFile(repoRoot: string, rel: string, content: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function commit(repoRoot: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repoRoot });
  execFileSync(
    "git",
    ["commit", "--quiet", "--allow-empty", "-m", "fixture"],
    { cwd: repoRoot },
  );
}

async function runSmoke(): Promise<void> {
  console.log("smoke-module-slicer — start");

  // ── Step 1 — synthetic two-module monorepo via npm workspaces ────
  {
    const repoRoot = mkFixture("two-module");
    writeFile(
      repoRoot,
      "package.json",
      JSON.stringify(
        {
          name: "monorepo-fixture",
          private: true,
          workspaces: ["apps/*"],
        },
        null,
        2,
      ),
    );

    // apps/api — Nest-style
    writeFile(
      repoRoot,
      "apps/api/package.json",
      JSON.stringify({ name: "@fixture/api", version: "0.0.0" }, null, 2),
    );
    writeFile(repoRoot, "apps/api/index.ts", "export {};\n");
    writeFile(
      repoRoot,
      "apps/api/src/billing.controller.ts",
      Array.from({ length: 80 }, (_, i) => `// billing line ${i}`).join("\n") +
        "\nexport class BillingController {}\n",
    );
    writeFile(
      repoRoot,
      "apps/api/src/auth.service.ts",
      "export class AuthService {}\n",
    );
    writeFile(
      repoRoot,
      "apps/api/README.md",
      "# fixture api\n\nthis is the api module.\n",
    );

    // apps/web — Next-style
    writeFile(
      repoRoot,
      "apps/web/package.json",
      JSON.stringify({ name: "@fixture/web", version: "0.0.0" }, null, 2),
    );
    writeFile(repoRoot, "apps/web/index.ts", "export {};\n");
    writeFile(
      repoRoot,
      "apps/web/src/router.ts",
      "export const routes = [];\n",
    );
    writeFile(
      repoRoot,
      "apps/web/src/components/Button.tsx",
      "export const Button = () => null;\n",
    );

    commit(repoRoot);

    const slices = sliceModules({ repoRoot });
    assert(
      slices.length === 2,
      `Step 1: expected 2 slices, got ${slices.length}: ${slices.map((s) => s.moduleSlug).join(", ")}`,
    );
    const slugs = slices.map((s) => s.moduleSlug).sort();
    assert(
      slugs[0] === "api" && slugs[1] === "web",
      `Step 1: expected slugs [api, web], got [${slugs.join(", ")}]`,
    );
    const apiSlice = slices.find((s) => s.moduleSlug === "api");
    assert(apiSlice !== undefined, "Step 1: api slice missing");
    assert(
      apiSlice.packageJson !== null,
      "Step 1: api packageJson should be non-null",
    );
    assert(
      apiSlice.packageJson.includes("@fixture/api"),
      `Step 1: api packageJson should mention @fixture/api`,
    );
    const apiRepFiles = apiSlice.representativeFiles.map((f) => f.path);
    assert(
      apiRepFiles.includes("index.ts"),
      `Step 1: api representative files should include index.ts; got [${apiRepFiles.join(", ")}]`,
    );
    assert(
      apiRepFiles.some((p) =>
        /controller\.ts$|service\.ts$/.test(p),
      ),
      `Step 1: api representative files should include a controller or service; got [${apiRepFiles.join(", ")}]`,
    );
    assert(
      apiSlice.localDocs !== null && apiSlice.localDocs.includes("fixture api"),
      "Step 1: api localDocs should contain README content",
    );

    const webSlice = slices.find((s) => s.moduleSlug === "web");
    assert(webSlice !== undefined, "Step 1: web slice missing");
    assert(
      webSlice.representativeFiles.length > 0,
      "Step 1: web representative files should be non-empty",
    );
    const webRepFiles = webSlice.representativeFiles.map((f) => f.path);
    assert(
      webRepFiles.includes("index.ts"),
      `Step 1: web representative files should include index.ts; got [${webRepFiles.join(", ")}]`,
    );
    console.log(
      `  ✓ Step 1 — two-module workspace produces ${slices.length} slices with expected slugs + reps`,
    );
  }

  // ── Step 2 — single-package repo collapses to one slice ──────────
  {
    const repoRoot = mkFixture("single-pkg");
    writeFile(repoRoot, "src/index.ts", "export {};\n");
    writeFile(
      repoRoot,
      "src/util.ts",
      "export const util = () => null;\n",
    );
    // No top-level package.json, no workspace config, no submodule, fewer
    // than 20 source files → falls through to single-package case.
    commit(repoRoot);
    const slices = sliceModules({ repoRoot });
    assert(
      slices.length === 1,
      `Step 2: expected 1 slice for single-package, got ${slices.length}`,
    );
    const only = slices[0];
    assert(only !== undefined, "Step 2: missing slice");
    assert(
      only.moduleRel === ".",
      `Step 2: single-package moduleRel should be '.', got '${only.moduleRel}'`,
    );
    console.log(`  ✓ Step 2 — single-package fixture collapses to one slice`);
  }

  // ── Step 3 — heuristic fallback (no workspace, no top-level pkg) ─
  {
    const repoRoot = mkFixture("heuristic");
    // Create one top-level dir with >20 source files. That's the only
    // "module" the heuristic should identify.
    for (let i = 0; i < 25; i++) {
      writeFile(repoRoot, `services/file${i}.ts`, "export {};\n");
    }
    writeFile(repoRoot, "README.md", "# top\n");
    commit(repoRoot);
    const slices = sliceModules({ repoRoot });
    assert(
      slices.length === 1,
      `Step 3: heuristic fixture should produce 1 slice, got ${slices.length}`,
    );
    const only = slices[0];
    assert(only !== undefined, "Step 3: missing slice");
    assert(
      only.moduleSlug === "services",
      `Step 3: heuristic slice slug should be 'services', got '${only.moduleSlug}'`,
    );
    console.log(
      `  ✓ Step 3 — heuristic fallback finds top-level dir with >20 source files`,
    );
  }

  // ── Step 4 — large module splits into sub-slices via wrapper ─────
  {
    const repoRoot = mkFixture("large-split");
    // Single workspace module `core/` with >150 source files split across
    // 4 subdirs (under src/). Expect: parent collapses, sub-slices for each
    // subdir, slugs prefixed with parent (e.g. "core/auth").
    writeFile(
      repoRoot,
      "package.json",
      JSON.stringify(
        { name: "monorepo-fixture", private: true, workspaces: ["packages/*"] },
        null,
        2,
      ),
    );
    writeFile(
      repoRoot,
      "packages/core/package.json",
      JSON.stringify({ name: "@fixture/core", version: "0.0.0" }, null, 2),
    );
    // 4 subdirs under packages/core/src — auth (40), billing (50),
    // integrations (40), telephony (30).
    const subs: Array<{ name: string; n: number }> = [
      { name: "auth", n: 40 },
      { name: "billing", n: 50 },
      { name: "integrations", n: 40 },
      { name: "telephony", n: 30 },
    ];
    for (const { name, n } of subs) {
      for (let i = 0; i < n; i++) {
        writeFile(
          repoRoot,
          `packages/core/src/${name}/file${i}.ts`,
          `export const x${i} = ${i};\n`,
        );
      }
    }
    writeFile(repoRoot, "packages/core/src/index.ts", "export {};\n");
    commit(repoRoot);

    const slices = sliceModules({ repoRoot });
    // 4 subdirs > SUBSLICE_SOURCE_THRESHOLD (20), all under MAX_SUBSLICES (6),
    // wrapper-strip resolves "core/src" → "core/<sub>".
    assert(
      slices.length === 4,
      `Step 4: expected 4 sub-slices (one parent split via src/ wrapper), got ${slices.length}: ${slices.map((s) => s.moduleSlug).join(", ")}`,
    );
    const slugs = slices.map((s) => s.moduleSlug).sort();
    assert(
      slugs[0] === "packages/core/auth" &&
        slugs[1] === "packages/core/billing" &&
        slugs[2] === "packages/core/integrations" &&
        slugs[3] === "packages/core/telephony",
      `Step 4: expected slugs [packages/core/auth, packages/core/billing, packages/core/integrations, packages/core/telephony], got [${slugs.join(", ")}]`,
    );
    // Sub-slice's modulePath should resolve through the wrapper (.../src/auth).
    const auth = slices.find((s) => s.moduleSlug === "packages/core/auth");
    assert(auth !== undefined, "Step 4: auth sub-slice missing");
    assert(
      auth.modulePath.endsWith("/packages/core/src/auth"),
      `Step 4: auth modulePath should end with /packages/core/src/auth, got '${auth.modulePath}'`,
    );
    // Sub-slice should inherit parent's package.json since auth/ has none of
    // its own.
    assert(
      auth.packageJson !== null && auth.packageJson.includes("@fixture/core"),
      "Step 4: auth sub-slice should fall back to parent's package.json",
    );
    console.log(
      `  ✓ Step 4 — large module split: 4 sub-slices via src/ wrapper-strip, parent package.json inherited`,
    );
  }

  console.log("smoke-module-slicer: OK");
}

runSmoke()
  .then(() => cleanup())
  .catch((err) => {
    console.error("smoke-module-slicer: FAIL");
    console.error(err);
    cleanup();
    process.exit(1);
  });
