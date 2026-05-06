#!/usr/bin/env tsx
/**
 * smoke-ingestion-baseline — Phase 6 wiring.
 *
 * Exercises ingest-docs (with a mocked classifier so we don't burn Haiku) +
 * baseline-audit + the SessionStart onboarding injection. End-to-end against a
 * fixture git repo.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSessionStartContext,
  defaultBaselineLanguages,
  findLatestBaselineAudit,
  runBaselineAudit,
  runDocsIngestion,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
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

function write(absPath: string, body: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, body, "utf8");
}

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-ingest-"));
  cleanups.push(dir);
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email smoke@example.com", { cwd: dir });
  execSync("git config user.name smoke", { cwd: dir });
  return dir;
}

async function runSmoke(): Promise<void> {
  console.log("smoke-ingestion-baseline — start");

  const repoRoot = mkFixture();

  // Seed ground state — voice.md with placeholder, canonical-map with 1 entry.
  write(
    join(repoRoot, ".cairn", "ground", "canonical-map", "topics.yaml"),
    `version: 1\ntopics:\n  - topic: agents-md\n    canonical_path: AGENTS.md\n    audience: dual\n`,
  );
  write(
    join(repoRoot, ".cairn", "ground", "brand", "voice.md"),
    `---\ntype: rule\nstatus: draft\naudience: dual\n---\n\n# Brand voice\n\n(operator: replace this paragraph with how Claude should communicate)\n`,
  );

  // Docs to ingest.
  write(
    join(repoRoot, "docs", "decisions.md"),
    `# Decisions\n\nWe never store API keys in source control. Auth tokens go to the keychain.\n`,
  );
  write(
    join(repoRoot, "docs", "tone.md"),
    `# Tone guidelines\n\nWrite like a senior engineer: terse, concrete, no marketing fluff.\n`,
  );
  write(
    join(repoRoot, "docs", "api.md"),
    `# API reference\n\nGET /v1/users — returns the active user record.\n`,
  );
  write(
    join(repoRoot, "AGENTS.md"),
    `# AGENTS.md\n\nThis project follows the Cairn adoption protocol.\n`,
  );

  // ── Step 1 — runDocsIngestion writes DEC drafts + canonical + voice ─
  {
    const result = await runDocsIngestion({
      repoRoot,
      mockClassify: (candidate, body) => {
        if (candidate.path.endsWith("decisions.md")) {
          return {
            kind: "decision",
            proposedTitle: "Auth tokens via keychain",
            proposedRationale: body.slice(0, 120),
            topicSlug: "auth-tokens",
          };
        }
        if (candidate.path.endsWith("tone.md")) {
          return {
            kind: "voice-guidelines",
            proposedTitle: "Brand voice",
            proposedRationale: "Tone guidelines for AI replies.",
            topicSlug: "brand-voice",
          };
        }
        if (candidate.path.endsWith("api.md")) {
          return {
            kind: "api-docs",
            proposedTitle: "User API surface",
            proposedRationale: "Documents the v1 user routes.",
            topicSlug: "api-users",
          };
        }
        return {
          kind: "other",
          proposedTitle: "",
          proposedRationale: "",
          topicSlug: "",
        };
      },
    });

    assert(
      result.decDraftsWritten.length === 1,
      `Step 1: expected 1 DEC draft, got ${result.decDraftsWritten.length}`,
    );
    const draft = result.decDraftsWritten[0];
    assert(draft !== undefined, "Step 1: draft entry undefined");
    if (draft === undefined) return;
    assert(
      existsSync(join(repoRoot, draft.path)),
      `Step 1: draft file missing on disk: ${draft.path}`,
    );
    assert(
      draft.id.startsWith("DEC-"),
      `Step 1: draft id malformed: ${draft.id}`,
    );

    const draftBody = readFileSync(join(repoRoot, draft.path), "utf8");
    assert(
      draftBody.includes("status: draft-from-init-docs"),
      "Step 1: draft missing status",
    );
    assert(
      draftBody.includes("sourceFile: docs/decisions.md"),
      "Step 1: draft missing sourceFile",
    );

    assert(
      result.canonicalTopicsAdded.length === 3,
      `Step 1: expected 3 canonical topics added, got ${result.canonicalTopicsAdded.length}`,
    );
    const topicsContent = readFileSync(
      join(repoRoot, ".cairn", "ground", "canonical-map", "topics.yaml"),
      "utf8",
    );
    assert(
      topicsContent.includes("topic: auth-tokens") &&
        topicsContent.includes("topic: brand-voice") &&
        topicsContent.includes("topic: api-users"),
      "Step 1: canonical-map missing one of the new topics",
    );

    assert(result.voiceUpdated, "Step 1: voice.md should have been rewritten");
    const voiceContent = readFileSync(
      join(repoRoot, ".cairn", "ground", "brand", "voice.md"),
      "utf8",
    );
    assert(
      voiceContent.includes("status: current") &&
        !voiceContent.includes("(operator: replace this paragraph"),
      "Step 1: voice.md still has placeholder",
    );

    console.log("  ✓ Step 1 — DEC drafts + canonical-map + voice.md");
  }

  // ── Step 2 — runBaselineAudit emits audit yaml ──────────────────────
  {
    // Add a TS source file with a known stub pattern so Layer A fires.
    write(
      join(repoRoot, "src", "core.ts"),
      `export async function fetchUser() {\n  // TODO: implement\n  throw new Error("not implemented");\n}\n`,
    );
    execSync("git add -A && git commit -q -m baseline", { cwd: repoRoot });

    const audit = await runBaselineAudit({
      repoRoot,
      languages: defaultBaselineLanguages(["typescript"]),
      projectGlobs: {
        route_handler_globs: [],
        dto_globs: [],
        generator_source_globs: [],
        high_stakes_globs: [],
      },
    });
    assert(
      existsSync(audit.auditPath),
      `Step 2: audit yaml missing at ${audit.auditPath}`,
    );
    assert(
      audit.filesScanned >= 1,
      `Step 2: filesScanned should be ≥1, got ${audit.filesScanned}`,
    );
    const found = findLatestBaselineAudit(repoRoot);
    assert(found !== null, "Step 2: findLatestBaselineAudit returned null");
    if (found === null) return;
    assert(
      found.path === audit.auditPath,
      `Step 2: latest audit path mismatch: ${found.path} vs ${audit.auditPath}`,
    );
    console.log(
      `  ✓ Step 2 — audit yaml written (${audit.totalFindings} findings on ${audit.filesScanned} files)`,
    );
  }

  // ── Step 3 — onboarding fires when decisions==0 + invariants==0 ────
  {
    const ctx = await buildSessionStartContext({
      repoRoot,
      source: "startup",
    });
    assert(
      ctx.sectionsRendered.includes("first_session_onboarding"),
      `Step 3: onboarding section missing — rendered: ${ctx.sectionsRendered.join(",")}`,
    );
    assert(
      ctx.additionalContext.includes("⬡ Cairn active"),
      "Step 3: onboarding header missing",
    );
    assert(
      ctx.additionalContext.includes("/cairn-direction"),
      "Step 3: onboarding /cairn-direction tip missing",
    );
    console.log("  ✓ Step 3 — onboarding injected at session start");
  }

  // ── Step 4 — onboarding disappears once a DEC is accepted ──────────
  {
    write(
      join(repoRoot, ".cairn", "ground", "decisions", "DEC-deadbee.md"),
      `---\nid: DEC-deadbee\ntitle: First real decision\ntype: adr\nstatus: accepted\naudience: dual\ngenerated: 2026-05-04T00:00:00Z\nverified-at: 2026-05-04T00:00:00Z\n---\n\n# DEC-deadbee — First real decision\n\nBody.\n`,
    );
    const ctx = await buildSessionStartContext({
      repoRoot,
      source: "startup",
    });
    assert(
      !ctx.sectionsRendered.includes("first_session_onboarding"),
      `Step 4: onboarding should be gone — rendered: ${ctx.sectionsRendered.join(",")}`,
    );
    console.log("  ✓ Step 4 — onboarding suppressed after first DEC");
  }

  console.log("smoke-ingestion-baseline — pass");
}

runSmoke()
  .then(() => cleanup())
  .catch((err: unknown) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
