#!/usr/bin/env tsx
/**
 * smoke-resolver — exercises LensResolver against a temp-dir fixture without
 * a VS Code host. Validates the citation-resolution surface that the providers
 * call into.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScopeIndex } from "@isaacriehm/cairn-core";
import { LensResolver } from "../dist/resolver.js";

const cleanups: string[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-lens-smoke-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-resolver — start");

  // ── Step 1 — resolveRepoRoot finds .cairn from nested cwd ─────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn"), { recursive: true });
    const nested = join(repoRoot, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const resolved = LensResolver.resolveRepoRoot(nested);
    assert(resolved === repoRoot, `Step 1: expected ${repoRoot}, got ${resolved}`);

    const noCairn = mkdtempSync(join(tmpdir(), "cairn-lens-bare-"));
    cleanups.push(noCairn);
    assert(
      LensResolver.resolveRepoRoot(noCairn) === null,
      "Step 1: bare dir should return null",
    );
    console.log("  ✓ Step 1 — resolveRepoRoot");
  }

  // ── Step 2 — resolveInvariant on missing ledger → unknown ───────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn", "ground", "invariants"), { recursive: true });
    const resolver = new LensResolver(repoRoot);
    const r = resolver.resolveInvariant("INV-2323232");
    assert(
      r.status === "unknown",
      `Step 2: expected unknown, got ${r.status}`,
    );
    assert(r.id === "INV-2323232", "Step 2: id round-trip");
    console.log("  ✓ Step 2 — resolveInvariant unknown path");
  }

  // ── Step 3 — resolveInvariant against seeded ledger → active ───
  {
    const repoRoot = mkFixture();
    const invDir = join(repoRoot, ".cairn", "ground", "invariants");
    mkdirSync(invDir, { recursive: true });
    writeFileSync(
      join(invDir, "invariants.ledger.yaml"),
      `- id: INV-2323232
  title: null-check before array destructure
  status: active
- id: INV-4141414
  title: bearer tokens must expire in ≤24h
  status: active
  superseded_by: INV-4242424
`,
      "utf8",
    );
    const resolver = new LensResolver(repoRoot);
    const active = resolver.resolveInvariant("INV-2323232");
    assert(
      active.status === "active" && active.title.includes("null-check"),
      `Step 3: INV-2323232 should be active, got ${JSON.stringify(active)}`,
    );
    const sup = resolver.resolveInvariant("INV-4141414");
    assert(
      sup.status === "superseded" && sup.supersededBy === "INV-4242424",
      `Step 3: INV-4141414 should be superseded by INV-4242424, got ${JSON.stringify(sup)}`,
    );
    console.log("  ✓ Step 3 — resolveInvariant active + superseded");
  }

  // ── Step 4 — resolveTask against active dir ─────────────────────
  {
    const repoRoot = mkFixture();
    const taskDir = join(repoRoot, ".cairn", "tasks", "active", "TSK-foo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "spec.tightened.md"),
      `---\nstatus: ready_to_dispatch\n---\n\n# Bearer token validation\n\nbody.\n`,
      "utf8",
    );
    const resolver = new LensResolver(repoRoot);
    const r = resolver.resolveTask("TSK-foo");
    assert(
      r.found === "active" && r.title === "Bearer token validation",
      `Step 4: expected active TSK-foo with title, got ${JSON.stringify(r)}`,
    );
    const missing = resolver.resolveTask("TSK-missing");
    assert(missing.found === "not_found", "Step 4: missing task → not_found");
    console.log("  ✓ Step 4 — resolveTask hit + miss");
  }

  // ── Step 5 — scope-index roundtrip via resolveScopeWithTitles ──
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn", "ground"), { recursive: true });
    writeScopeIndex(repoRoot, {
      generated: "2026-05-04T03:00:00Z",
      files: {
        "src/auth/login.ts": {
          decisions: ["DEC-deadbee"],
          invariants: ["INV-2323232"],
        },
        ".eslintrc.json": {
          decisions: [],
          invariants: [],
          unscoped: true,
        },
      },
    });
    const resolver = new LensResolver(repoRoot);
    const scope = resolver.resolveScopeWithTitles("src/auth/login.ts");
    assert(scope !== null, "Step 5: scope should be non-null");
    if (scope === null) return;
    assert(
      scope.decisions.length === 1 && scope.decisions[0]?.id === "DEC-deadbee",
      `Step 5: decisions wrong, got ${JSON.stringify(scope.decisions)}`,
    );
    assert(
      scope.invariants.length === 1 && scope.invariants[0]?.id === "INV-2323232",
      `Step 5: invariants wrong, got ${JSON.stringify(scope.invariants)}`,
    );
    const lint = resolver.resolveScopeWithTitles(".eslintrc.json");
    assert(lint !== null && lint.unscoped === true, "Step 5: unscoped flag");
    const missing = resolver.resolveScopeWithTitles("src/missing.ts");
    assert(missing === null, "Step 5: missing path → null");
    console.log("  ✓ Step 5 — scope-index roundtrip");
  }

  console.log("smoke-resolver — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
