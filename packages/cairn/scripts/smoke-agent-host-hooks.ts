#!/usr/bin/env tsx
/** smoke-agent-host-hooks — shared Claude Code, Cursor, and Codex hook contract */

import {
  buildStopResult,
  extractWrittenPaths,
  normalizePostToolUse,
  resolveAgentHost,
  serializePostToolUse,
  serializeSessionStart,
  serializeStop,
} from "@isaacriehm/cairn-core";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${message}\n  expected: ${expectedJson}\n  actual:   ${actualJson}`);
}

console.log("smoke-agent-host-hooks — start");

assert(resolveAgentHost("claude-code") === "claude-code", "explicit Claude Code host");
assert(resolveAgentHost("cursor") === "cursor", "explicit Cursor host");
assert(resolveAgentHost("codex") === "codex", "explicit Codex host");
console.log("  ✓ explicit host resolution");

const cursorWrite = normalizePostToolUse({
  tool_name: "Write",
  tool_input: { path: "src/a.ts", contents: "export const a = 1;" },
  tool_output: "{}",
});
assert(cursorWrite.tool_input?.file_path === "src/a.ts", "Cursor path→file_path");
assert(cursorWrite.tool_input?.content === "export const a = 1;", "Cursor contents→content");
console.log("  ✓ Cursor write payload normalization");

const codexPatch = normalizePostToolUse({
  hook_event_name: "PostToolUse",
  tool_name: "apply_patch",
  tool_use_id: "call_patch",
  tool_input: {
    command:
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
  },
});
assert(codexPatch.tool_name === "apply_patch", "Codex apply_patch name preserved");
assert(
  codexPatch.tool_input?.command?.includes("*** Update File: src/a.ts"),
  "Codex apply_patch command preserved",
);
assertDeepEqual(
  extractWrittenPaths(codexPatch.tool_name, codexPatch.tool_input),
  ["src/a.ts"],
  "Codex apply_patch paths",
);
const codexMultiPatch = normalizePostToolUse({
  tool_name: "apply_patch",
  tool_input: {
    command:
      "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Delete File: src/old.ts\n*** End Patch",
  },
});
assertDeepEqual(
  extractWrittenPaths(codexMultiPatch.tool_name, codexMultiPatch.tool_input),
  ["src/a.ts", "src/b.ts"],
  "Codex apply_patch must process every surviving written file",
);
const codexMovePatch = normalizePostToolUse({
  tool_name: "apply_patch",
  tool_input: {
    command:
      "*** Begin Patch\n*** Update File: src/old-name.ts\n*** Move to: src/new-name.ts\n@@\n-old\n+new\n*** End Patch",
  },
});
assertDeepEqual(
  extractWrittenPaths(codexMovePatch.tool_name, codexMovePatch.tool_input),
  ["src/new-name.ts"],
  "Codex apply_patch must inspect a moved file at its destination",
);
console.log("  ✓ Codex apply_patch payload normalization");

for (const host of ["claude-code", "codex"] as const) {
  assertDeepEqual(
    serializeSessionStart(host, { kind: "continue", context: "ground" }),
    {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "ground",
      },
    },
    `${host} SessionStart envelope`,
  );
}
assertDeepEqual(
  buildStopResult("codex", { reason: "", systemMessage: "notice" }),
  { kind: "continue", message: "notice" },
  "Codex non-blocking Stop notice stays non-blocking",
);
assertDeepEqual(
  buildStopResult("cursor", { reason: "", systemMessage: "notice" }),
  { kind: "follow-up", prompt: "notice" },
  "Cursor Stop notice uses its native follow-up channel",
);
assertDeepEqual(
  serializeSessionStart("cursor", { kind: "continue", context: "ground" }),
  { additional_context: "ground" },
  "Cursor SessionStart envelope",
);
console.log("  ✓ SessionStart serialization");

assertDeepEqual(
  serializePostToolUse("claude-code", { kind: "continue", context: "ground" }),
  {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "ground",
    },
  },
  "Claude Code PostToolUse context",
);
assertDeepEqual(
  serializePostToolUse("codex", { kind: "continue", context: "ground" }),
  {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "ground",
    },
  },
  "Codex PostToolUse context",
);
assertDeepEqual(
  serializePostToolUse("cursor", { kind: "continue", context: "ground" }),
  { additional_context: "ground" },
  "Cursor PostToolUse context",
);
assertDeepEqual(
  serializePostToolUse("claude-code", { kind: "block", reason: "repair" }),
  { continue: false, decision: "block", reason: "repair" },
  "Claude Code PostToolUse block",
);
assertDeepEqual(
  serializePostToolUse("codex", { kind: "block", reason: "repair" }),
  { continue: false, stopReason: "repair" },
  "Codex PostToolUse block",
);
assertDeepEqual(
  serializePostToolUse("cursor", { kind: "block", reason: "repair" }),
  { additional_context: "repair" },
  "Cursor PostToolUse advisory block",
);
console.log("  ✓ PostToolUse serialization");

for (const host of ["claude-code", "codex"] as const) {
  assertDeepEqual(
    serializeStop(host, { kind: "follow-up", prompt: "continue" }),
    { decision: "block", reason: "continue" },
    `${host} Stop continuation`,
  );
}
assertDeepEqual(
  serializeStop(
    "cursor",
    { kind: "follow-up", prompt: "continue" },
    { status: "completed", continuationCount: 0, continuationLimit: 5 },
  ),
  { followup_message: "continue" },
  "Cursor Stop continuation",
);
assertDeepEqual(
  serializeStop(
    "cursor",
    { kind: "follow-up", prompt: "continue" },
    { status: "error", continuationCount: 0, continuationLimit: 5 },
  ),
  {},
  "Cursor error Stop cannot continue",
);
assertDeepEqual(
  serializeStop(
    "cursor",
    { kind: "follow-up", prompt: "continue" },
    { status: "completed", continuationCount: 5, continuationLimit: 5 },
  ),
  {},
  "Cursor Stop respects continuation limit",
);
console.log("  ✓ Stop serialization");

console.log("smoke-agent-host-hooks — pass");
