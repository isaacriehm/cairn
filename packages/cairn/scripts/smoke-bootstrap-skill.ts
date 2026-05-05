#!/usr/bin/env tsx
/**
 * smoke-bootstrap-skill — verify the cairn-bootstrap +
 * cairn-statusline-setup skill files exist, parse correct
 * frontmatter, and reference the bundle path (not npx / globally
 * installed cairn) per the v0.2.0 H principle (zero CLI surface in
 * operator-facing chat).
 *
 * Operator-facing skill bodies are the one place where the bundle
 * path *can* be referenced (the skill spawns the subprocess); they
 * must NOT mention `npx ... cairn ...` or assume `cairn` on PATH.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "packages", "cairn-frontend-claudecode");

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

function readSkill(slug: string): { fm: string; body: string; full: string } {
  const path = join(PLUGIN_ROOT, "skills", slug, "SKILL.md");
  assert(existsSync(path), `${slug}/SKILL.md missing at ${path}`);
  const text = readFileSync(path, "utf8");
  assert(text.startsWith("---\n"), `${slug}: must start with frontmatter`);
  const end = text.indexOf("\n---", 4);
  assert(end !== -1, `${slug}: frontmatter not terminated`);
  return {
    fm: text.slice(4, end),
    body: text.slice(end + 4).trim(),
    full: text,
  };
}

function runSmoke(): void {
  console.log("smoke-bootstrap-skill — start");

  // ── Step 1 — cairn-bootstrap skill present + valid ──────────────
  {
    const { fm, body } = readSkill("cairn-bootstrap");
    assert(/^name:\s*cairn-bootstrap/m.test(fm), "Step 1: name field");
    assert(/^description:/m.test(fm), "Step 1: description field");
    assert(body.length > 200, `Step 1: body too short (${body.length} chars)`);
    assert(
      body.includes("CLAUDE_PLUGIN_ROOT") || body.includes("dist/cli.mjs"),
      "Step 1: must reference the bundle path (not npx / global cairn)",
    );
    assert(
      !/npx\s+-y\s+@isaacriehm\/cairn/.test(body),
      "Step 1: must NOT reference `npx -y @isaacriehm/cairn`",
    );
    console.log("  ✓ Step 1 — cairn-bootstrap valid + references bundle");
  }

  // ── Step 2 — cairn-statusline-setup present + references shim ──
  {
    const { fm, body } = readSkill("cairn-statusline-setup");
    assert(/^name:\s*cairn-statusline-setup/m.test(fm), "Step 2: name field");
    assert(/^description:/m.test(fm), "Step 2: description field");
    assert(body.length > 200, `Step 2: body too short (${body.length} chars)`);
    assert(
      body.includes(".active-version-path"),
      "Step 2: must reference the shim file path",
    );
    assert(
      body.includes("statusLine"),
      "Step 2: must mention the settings.json statusLine field",
    );
    assert(
      !/npx\s+-y\s+@isaacriehm\/cairn/.test(body),
      "Step 2: must NOT reference `npx -y @isaacriehm/cairn`",
    );
    console.log("  ✓ Step 2 — cairn-statusline-setup valid + references shim");
  }

  // ── Step 3 — cairn-adopt skill (rewritten in commit 5) is clean ─
  {
    const { body } = readSkill("cairn-adopt");
    assert(
      !/npx\s+-y\s+@isaacriehm\/cairn/.test(body),
      "Step 3: cairn-adopt must NOT reference `npx -y @isaacriehm/cairn` post-commit-5",
    );
    assert(
      body.includes("cairn_init_resume") || body.includes("cairn_init_phase"),
      "Step 3: cairn-adopt must reference the MCP init tools",
    );
    console.log("  ✓ Step 3 — cairn-adopt body is CLI-surface-free");
  }

  // ── Step 4 — SessionStart bootstrap banner names the skill ─────
  {
    const sessionStartPath = join(
      REPO_ROOT,
      "packages",
      "cairn-core",
      "src",
      "hooks",
      "runners",
      "session-start.ts",
    );
    const text = readFileSync(sessionStartPath, "utf8");
    assert(
      text.includes("cairn-bootstrap"),
      "Step 4: SessionStart bootstrap banner must reference the cairn-bootstrap skill by name",
    );
    assert(
      !/npx\s+-y\s+@isaacriehm\/cairn join/.test(text),
      "Step 4: bootstrap banner must NOT print `npx -y @isaacriehm/cairn join` directly",
    );
    console.log("  ✓ Step 4 — SessionStart banner names cairn-bootstrap skill");
  }

  console.log("smoke-bootstrap-skill — pass");
}

runSmoke();
