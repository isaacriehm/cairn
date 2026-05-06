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
  buildTopicIndex,
  defaultBaselineLanguages,
  findLatestBaselineAudit,
  runBaselineAudit,
  runDocsIngestion,
  type SemanticJudge,
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

  // Docs to ingest. Each paragraph is sized above the phase 5b
  // walker's 80-char + 10-unique-token thresholds so the topic-index
  // actually indexes them.
  write(
    join(repoRoot, "docs", "decisions.md"),
    `# Decisions\n\nWe never store API keys in source control. Auth tokens go to the keychain wherever the host platform exposes one, and to an encrypted dotfile otherwise. The threat model is a stolen developer laptop, not a network attacker.\n`,
  );
  write(
    join(repoRoot, "docs", "tone.md"),
    `# Tone guidelines\n\nWrite like a senior engineer: terse and concrete, no marketing fluff. Lead with the answer or action. Skip openers, closers, and transitional language. If a response requires explanation, use the minimum words that convey the information accurately.\n`,
  );
  write(
    join(repoRoot, "docs", "api.md"),
    `# API reference\n\nGET /v1/users — returns the active user record. The endpoint validates the bearer token, looks up the session in Redis, and emits a structured user payload with profile fields and feature flags. Errors are surfaced as JSON problem details.\n`,
  );
  write(
    join(repoRoot, "AGENTS.md"),
    `# AGENTS.md\n\nThis project follows the Cairn adoption protocol.\n`,
  );

  // ── Step 1 — phase 5b builds topic-index, phase 6 emits verbatim DECs
  {
    // Phase 5b — build topic-index from the docs we just wrote.
    const judge: SemanticJudge = async () => "different";
    const topicResult = await buildTopicIndex({ repoRoot, judge });
    assert(
      Object.keys(topicResult.topicIndex.topics).length >= 3,
      `Step 1a: phase 5b should index ≥3 paragraphs, got ${
        Object.keys(topicResult.topicIndex.topics).length
      }`,
    );

    // Phase 6 — emit DECs for docs/* topic entries via mockClassify.
    const result = await runDocsIngestion({
      repoRoot,
      mockClassify: (entry) => {
        if (entry.sot_source.endsWith("decisions.md")) {
          return { kind: "decision", proposedTitle: "Auth tokens via keychain" };
        }
        if (entry.sot_source.endsWith("tone.md")) {
          return { kind: "voice-guidelines", proposedTitle: "Brand voice" };
        }
        if (entry.sot_source.endsWith("api.md")) {
          return { kind: "api-docs", proposedTitle: "User API surface" };
        }
        return { kind: "other", proposedTitle: "" };
      },
    });

    assert(
      result.decsWritten.length === 1,
      `Step 1: expected 1 DEC, got ${result.decsWritten.length}`,
    );
    const dec = result.decsWritten[0];
    assert(dec !== undefined, "Step 1: dec entry undefined");
    if (dec === undefined) return;
    assert(
      existsSync(join(repoRoot, dec.path)),
      `Step 1: dec file missing on disk: ${dec.path}`,
    );
    assert(
      dec.id.startsWith("DEC-"),
      `Step 1: dec id malformed: ${dec.id}`,
    );
    assert(
      dec.path === `.cairn/ground/decisions/${dec.id}.md`,
      `Step 1: dec path should be ground/decisions/, got ${dec.path}`,
    );

    const decBody = readFileSync(join(repoRoot, dec.path), "utf8");
    assert(
      decBody.includes("status: accepted"),
      "Step 1: emitted DEC should be auto-promoted to status: accepted",
    );
    assert(
      decBody.includes("sot_kind: path"),
      "Step 1: emitted DEC missing sot_kind: path",
    );
    assert(
      decBody.includes("sot_path: docs/decisions.md"),
      "Step 1: emitted DEC missing sot_path docs/decisions.md",
    );
    assert(
      decBody.includes("never store API keys"),
      "Step 1: emitted DEC body should be verbatim source paragraph",
    );

    const bindings = readFileSync(
      join(repoRoot, ".cairn", "ground", "sot-bindings.yaml"),
      "utf8",
    );
    assert(
      bindings.includes(dec.id) && bindings.includes("docs/decisions.md"),
      "Step 1: sot-bindings.yaml should contain the new DEC id and its path",
    );
    console.log("  ✓ Step 1 — verbatim DEC emitted via topic-index + sot-bindings written");
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

  // ── Step 3 — onboarding fires on a fresh repo (no DECs / INVs) ────
  {
    const freshRoot = mkFixture();
    execSync("git add . && git commit --allow-empty -q -m fresh", { cwd: freshRoot });
    await runBaselineAudit({
      repoRoot: freshRoot,
      languages: defaultBaselineLanguages(["typescript"]),
      projectGlobs: {
        route_handler_globs: [],
        dto_globs: [],
        generator_source_globs: [],
        high_stakes_globs: [],
      },
    });
    const ctx = await buildSessionStartContext({
      repoRoot: freshRoot,
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
    console.log("  ✓ Step 3 — onboarding injected on fresh repo");
  }

  // ── Step 4 — onboarding suppressed once a DEC is accepted ─────────
  {
    // Step 1 already emitted an accepted DEC into this repoRoot; the
    // onboarding suppressor should pick that up and stay quiet.
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
