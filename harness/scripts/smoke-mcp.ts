#!/usr/bin/env tsx
/**
 * smoke-mcp — Phase 4 acceptance sensor.
 *
 * Per MCP_SURFACE.md / INTEGRATION_PLAN.md Phase 4:
 *   "integration test exercises every tool; assertions on output shape;
 *    rejection cases (missing id, path not in allowlist) produce structured
 *    errors."
 *
 * Uses MCP SDK's InMemoryTransport — server + client run in-process linked
 * via a transport pair. No subprocess, no real stdio. The server is the same
 * code path that ships in production; only the transport is swapped.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
import { stringify as stringifyYaml } from "yaml";
import { startMcpServer, createContext } from "../src/mcp/index.js";

interface CallToolResultText {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

let cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-mcp FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of cleanupPaths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function seedRepo(root: string): void {
  mkdirSync(join(root, ".harness", "ground", "decisions"), { recursive: true });
  mkdirSync(join(root, ".harness", "ground", "invariants"), { recursive: true });
  mkdirSync(join(root, ".harness", "ground", "canonical-map"), { recursive: true });
  mkdirSync(join(root, ".harness", "tasks", "active", "TSK-seed"), { recursive: true });
  mkdirSync(join(root, ".harness", "runs", "active", "run-seed"), { recursive: true });
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  // Two decisions — DEC-0001 supersedes nothing; DEC-0002 supersedes DEC-0001.
  writeFileSync(
    join(root, ".harness", "ground", "decisions", "DEC-0001.md"),
    [
      "---",
      "id: DEC-0001",
      "title: original integrations design",
      "type: adr",
      "status: superseded",
      "audience: dual",
      "scope_globs:",
      "  - core/src/integrations/**",
      "decided_at: 2026-04-01",
      "---",
      "",
      "# DEC-0001",
      "",
      "Symbol mentioned: IntegrationsService.merge",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".harness", "ground", "decisions", "DEC-0002.md"),
    [
      "---",
      "id: DEC-0002",
      "title: tightened integrations scope",
      "type: adr",
      "status: accepted",
      "audience: dual",
      "scope_globs:",
      "  - core/src/integrations/**",
      "supersedes: DEC-0001",
      "decided_at: 2026-04-15",
      "---",
      "",
      "# DEC-0002",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, ".harness", "ground", "invariants", "V0001.md"),
    [
      "---",
      "id: V0001",
      "title: integrations cross-tenant scope",
      "type: invariant",
      "status: active",
      "audience: dual",
      "source_decision: DEC-0002",
      "---",
      "",
      "# V0001",
      "",
    ].join("\n"),
  );

  // canonical-map topic
  writeFileSync(
    join(root, ".claude", "rules", "event-naming.md"),
    "---\ntype: rule\nstatus: accepted\naudience: dual\nverified-at: 2026-05-02T00:00:00Z\n---\n\n# Event naming rule\n",
  );
  writeFileSync(
    join(root, ".harness", "ground", "canonical-map", "topics.yaml"),
    stringifyYaml({
      version: 1,
      topics: [
        {
          topic: "event-naming",
          canonical_path: ".claude/rules/event-naming.md",
          audience: "dual",
        },
      ],
    }),
  );

  // task spec
  writeFileSync(
    join(root, ".harness", "tasks", "active", "TSK-seed", "spec.md"),
    [
      "---",
      "id: TSK-seed",
      "type: spec",
      "status: tightening",
      "audience: dual",
      "intent: fix_issue",
      "---",
      "",
      "# add unique partial index",
      "",
      "body",
      "",
    ].join("\n"),
  );

  // run meta
  writeFileSync(
    join(root, ".harness", "runs", "active", "run-seed", "meta.json"),
    JSON.stringify(
      {
        run_id: "run-seed",
        task_id: "TSK-seed",
        agent_role: "implementer",
        started_at: "2026-05-02T00:00:00Z",
        finished_at: "2026-05-02T00:05:00Z",
        phase: "succeeded",
      },
      null,
      2,
    ),
  );

  // manifest stub
  mkdirSync(join(root, ".harness", "ground"), { recursive: true });
  writeFileSync(
    join(root, ".harness", "ground", "manifest.yaml"),
    stringifyYaml({ version: 1, generated: new Date().toISOString(), files: [] }),
  );
}

interface ParsedPayload {
  ok: boolean;
  isError: boolean;
  parsed: unknown;
}

async function call(client: Client, name: string, args: object): Promise<ParsedPayload> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResultText;
  const text = res.content?.[0]?.text ?? "";
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  const isError = res.isError === true;
  return { ok: !isError, isError, parsed };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-mcp-"));
  cleanupPaths.push(root);
  seedRepo(root);

  header("Step 1: start MCP server (in-memory) + client");
  const ctx = createContext({ repoRoot: root });
  const { server, close } = await startMcpServer({ ctx, noConnect: true });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "smoke-mcp", version: "0.0.0" });
  await client.connect(clientTransport);

  header("Step 2: tool discovery");
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  const expected = [
    "harness_append",
    "harness_archive",
    "harness_canonical_for_topic",
    "harness_decision_get",
    "harness_decisions_for_symbol",
    "harness_decisions_in_scope",
    "harness_drop_task",
    "harness_get_full",
    "harness_ground_get",
    "harness_invariant_get",
    "harness_invariants_in_scope",
    "harness_query_history",
    "harness_record_decision",
    "harness_record_run_event",
    "harness_search",
    "harness_supersedes_chain",
    "harness_timeline",
  ];
  for (const name of expected) {
    if (!toolNames.includes(name)) fail(`tool not registered: ${name}`);
  }

  header("Step 3: read tools — graph traversal");
  let r = await call(client, "harness_decision_get", { id: "DEC-0002" });
  if (!r.ok || (r.parsed as { id?: string }).id !== "DEC-0002") fail(`decision_get: ${JSON.stringify(r.parsed)}`);
  r = await call(client, "harness_decision_get", { id: "DEC-9999" });
  if (!r.isError) fail("decision_get missing-id should error");

  r = await call(client, "harness_decisions_in_scope", {
    path_globs: ["core/src/integrations/**"],
  });
  if (!r.ok || !Array.isArray(r.parsed) || (r.parsed as unknown[]).length !== 1) {
    fail(`decisions_in_scope: ${JSON.stringify(r.parsed)}`);
  }

  r = await call(client, "harness_decisions_for_symbol", {
    file: "core/src/integrations/IntegrationsService.ts",
    symbol: "IntegrationsService.merge",
  });
  if (!r.ok || !Array.isArray(r.parsed)) fail(`decisions_for_symbol: ${JSON.stringify(r.parsed)}`);

  r = await call(client, "harness_canonical_for_topic", { topic: "event-naming" });
  if (!r.ok || (r.parsed as { topic?: string }).topic !== "event-naming") {
    fail(`canonical_for_topic: ${JSON.stringify(r.parsed)}`);
  }
  r = await call(client, "harness_canonical_for_topic", { topic: "nonexistent" });
  if (!r.isError) fail("canonical_for_topic unknown topic should error");

  r = await call(client, "harness_ground_get", { category: "manifest" });
  if (!r.ok) fail(`ground_get manifest: ${JSON.stringify(r.parsed)}`);

  r = await call(client, "harness_supersedes_chain", { decision_id: "DEC-0002" });
  if (!r.ok || !Array.isArray(r.parsed) || (r.parsed as unknown[]).length !== 2) {
    fail(`supersedes_chain: ${JSON.stringify(r.parsed)}`);
  }

  r = await call(client, "harness_invariant_get", { id: "V0001" });
  if (!r.ok || (r.parsed as { id?: string }).id !== "V0001") {
    fail(`invariant_get: ${JSON.stringify(r.parsed)}`);
  }
  r = await call(client, "harness_invariant_get", { id: "V9999" });
  if (!r.isError) fail("invariant_get missing-id should error");

  r = await call(client, "harness_invariants_in_scope", {
    path_globs: ["core/src/integrations/**"],
  });
  if (!r.ok || !Array.isArray(r.parsed) || (r.parsed as unknown[]).length !== 1) {
    fail(`invariants_in_scope: ${JSON.stringify(r.parsed)}`);
  }

  header("Step 4: 3-layer progressive retrieval");
  r = await call(client, "harness_search", { query: "integrations" });
  if (!r.ok || !Array.isArray(r.parsed) || (r.parsed as unknown[]).length === 0) {
    fail(`search: ${JSON.stringify(r.parsed)}`);
  }

  r = await call(client, "harness_timeline", {});
  if (!r.ok || !Array.isArray(r.parsed)) fail(`timeline: ${JSON.stringify(r.parsed)}`);

  r = await call(client, "harness_get_full", { id: "DEC-0002", kind: "decision" });
  if (!r.ok || typeof (r.parsed as { content?: string }).content !== "string") {
    fail(`get_full decision: ${JSON.stringify(r.parsed)}`);
  }

  header("Step 5: query_history — must return NOT_IMPLEMENTED");
  r = await call(client, "harness_query_history", { scope: "anything" });
  if (!r.isError) fail("query_history should return error envelope");
  const errCode = (r.parsed as { error?: { code?: string } }).error?.code;
  if (errCode !== "NOT_IMPLEMENTED") fail(`query_history wrong code: ${errCode}`);

  header("Step 6: write tools");
  r = await call(client, "harness_append", {
    path: ".harness/runs/active/run-seed/events.jsonl",
    content: JSON.stringify({ kind: "phase_transition", to: "finishing" }),
  });
  if (!r.ok) fail(`append allowed-path: ${JSON.stringify(r.parsed)}`);

  r = await call(client, "harness_append", {
    path: "core/src/secrets.ts",
    content: "evil",
  });
  if (!r.isError) fail("append disallowed-path should error");

  r = await call(client, "harness_record_run_event", {
    run_id: "run-seed",
    event: { kind: "tool_use", payload: { tool: "Read" } },
  });
  if (!r.ok) fail(`record_run_event: ${JSON.stringify(r.parsed)}`);

  r = await call(client, "harness_drop_task", {
    title: "test task",
    body: "exercise drop_task",
    intent: "review_module",
  });
  if (!r.ok || typeof (r.parsed as { id?: string }).id !== "string") {
    fail(`drop_task: ${JSON.stringify(r.parsed)}`);
  }

  // archive — try to archive a sacred path (should refuse)
  r = await call(client, "harness_archive", {
    path: "AGENTS.md",
    reason: "test deny",
  });
  if (!r.isError) fail("archive sacred path should error");
  // archive — try to archive a real file
  writeFileSync(join(root, "STALE_NOTE.md"), "stale\n");
  r = await call(client, "harness_archive", {
    path: "STALE_NOTE.md",
    reason: "smoke",
  });
  if (!r.ok) fail(`archive: ${JSON.stringify(r.parsed)}`);

  r = await call(client, "harness_record_decision", {
    title: "smoke decision",
    summary: "drops to inbox by default",
    scope_globs: ["docs/**"],
  });
  if (!r.ok || typeof (r.parsed as { id?: string }).id !== "string") {
    fail(`record_decision: ${JSON.stringify(r.parsed)}`);
  }
  // verify draft was written
  const allocated = (r.parsed as { id: string }).id;
  if (!existsSync(join(root, ".harness", "ground", "decisions", "_inbox", `${allocated}.draft.md`))) {
    fail("record_decision draft not written");
  }
  // duplicate id should fail
  r = await call(client, "harness_record_decision", {
    id: allocated,
    title: "x",
    summary: "y",
    scope_globs: ["docs/**"],
  });
  if (!r.isError) fail("record_decision duplicate id should error");

  header("Step 7: telemetry — mcp-calls.jsonl exists");
  const telemetry = join(root, ".harness", "staleness", "mcp-calls.jsonl");
  if (!existsSync(telemetry)) fail(`telemetry not written at ${telemetry}`);
  const rows = readFileSync(telemetry, "utf8").trim().split("\n");
  if (rows.length < 17) fail(`expected at least 17 telemetry rows, got ${rows.length}`);

  header("Step 8: shutdown + cleanup");
  await client.close();
  await close();
  cleanup();
  console.log("\nsmoke-mcp: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
