#!/usr/bin/env tsx
/**
 * smoke-attention-serve — verifies the browser triage GUI's HTTP
 * surface: server boot, /api/state, accept + reject, sentinel
 * write on /api/done.
 *
 * Spec: PLUGIN_ARCHITECTURE §11 (attention surface) — v0.4.3 GUI path.
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
import { join } from "node:path";
import { startAttentionServer } from "@isaacriehm/cairn-core";

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

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-serve-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground", "decisions", "_inbox"), {
    recursive: true,
  });
  return dir;
}

function writeDraft(repoRoot: string, id: string, title: string): void {
  const path = join(
    repoRoot,
    ".cairn",
    "ground",
    "decisions",
    "_inbox",
    `${id}.draft.md`,
  );
  const body = `---
id: ${id}
title: ${title}
status: draft
capture_source: smoke
---

# ${id} — ${title}

## Proposed rationale

Sample rationale for ${title}.
`;
  writeFileSync(path, body, "utf8");
}

async function fetchJson(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, body };
}

async function runSmoke(): Promise<void> {
  console.log("smoke-attention-serve — start");

  const repoRoot = mkRepoRoot();
  writeDraft(repoRoot, "DEC-aaa1111", "alpha draft");
  writeDraft(repoRoot, "DEC-bbb2222", "beta draft");
  writeDraft(repoRoot, "DEC-ccc3333", "gamma draft");

  const handle = await startAttentionServer({
    repoRoot,
    port: 0,
    idleTimeoutMs: 30_000,
  });

  // ── Step 1 — GET /api/state lists all three drafts ──────────────
  {
    const res = await fetchJson(`${handle.url}api/state`);
    assert(res.status === 200, `Step 1: /api/state status=${res.status}`);
    const body = res.body as { drafts: { id: string }[]; counts: { drafts: number } };
    assert(
      body.drafts.length === 3,
      `Step 1: expected 3 drafts, got ${body.drafts.length}`,
    );
    assert(body.counts.drafts === 3, `Step 1: counts.drafts mismatch`);
    console.log("  ✓ Step 1 — /api/state lists drafts");
  }

  // ── Step 2 — accept moves draft to canonical ────────────────────
  {
    const res = await fetchJson(
      `${handle.url}api/draft/DEC-aaa1111/accept`,
      { method: "POST" },
    );
    assert(res.status === 200, `Step 2: accept status=${res.status}`);
    const acceptedPath = join(
      repoRoot,
      ".cairn",
      "ground",
      "decisions",
      "DEC-aaa1111.md",
    );
    assert(existsSync(acceptedPath), "Step 2: accepted .md file should exist");
    const draftPath = join(
      repoRoot,
      ".cairn",
      "ground",
      "decisions",
      "_inbox",
      "DEC-aaa1111.draft.md",
    );
    assert(!existsSync(draftPath), "Step 2: draft should be removed from inbox");
    console.log("  ✓ Step 2 — accept promoted to canonical");
  }

  // ── Step 3 — reject renames to .rejected.md ────────────────────
  {
    const res = await fetchJson(
      `${handle.url}api/draft/DEC-bbb2222/reject`,
      { method: "POST" },
    );
    assert(res.status === 200, `Step 3: reject status=${res.status}`);
    const rejectedPath = join(
      repoRoot,
      ".cairn",
      "ground",
      "decisions",
      "_inbox",
      "DEC-bbb2222.rejected.md",
    );
    assert(existsSync(rejectedPath), "Step 3: rejected file should exist");
    console.log("  ✓ Step 3 — reject renamed to .rejected.md");
  }

  // ── Step 4 — heartbeat returns ok ───────────────────────────────
  {
    const res = await fetchJson(`${handle.url}api/heartbeat`, {
      method: "POST",
    });
    assert(res.status === 200, `Step 4: heartbeat status=${res.status}`);
    console.log("  ✓ Step 4 — heartbeat ok");
  }

  // ── Step 5 — /api/done writes sentinel + shuts down ─────────────
  {
    const res = await fetchJson(`${handle.url}api/done`, { method: "POST" });
    assert(res.status === 200, `Step 5: done status=${res.status}`);
    const state = await handle.done;
    assert(state.reason === "done", `Step 5: reason=${state.reason}`);
    assert(state.accepted === 1, `Step 5: accepted=${state.accepted}`);
    assert(state.rejected === 1, `Step 5: rejected=${state.rejected}`);
    assert(
      existsSync(handle.sentinelPath),
      "Step 5: sentinel file should exist",
    );
    const sentinel = JSON.parse(readFileSync(handle.sentinelPath, "utf8"));
    assert(
      sentinel.reason === "done" && sentinel.accepted === 1,
      `Step 5: sentinel content ${JSON.stringify(sentinel)}`,
    );
    console.log("  ✓ Step 5 — done sentinel written + server shut down");
  }

  console.log("smoke-attention-serve — pass");
}

try {
  await runSmoke();
} finally {
  cleanup();
}
