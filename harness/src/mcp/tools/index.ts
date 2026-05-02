import type { ToolDef } from "./types.js";
import { appendTool } from "./append.js";
import { archiveTool } from "./archive.js";
import { canonicalForTopicTool } from "./canonical-for-topic.js";
import { decisionGetTool } from "./decision-get.js";
import { decisionsForSymbolTool } from "./decisions-for-symbol.js";
import { decisionsInScopeTool } from "./decisions-in-scope.js";
import { dropTaskTool } from "./drop-task.js";
import { getFullTool } from "./get-full.js";
import { groundGetTool } from "./ground-get.js";
import { invariantGetTool } from "./invariant-get.js";
import { invariantsInScopeTool } from "./invariants-in-scope.js";
import { queryHistoryTool } from "./query-history.js";
import { recordDecisionTool } from "./record-decision.js";
import { recordRunEventTool } from "./record-run-event.js";
import { searchTool } from "./search.js";
import { supersedesChainTool } from "./supersedes-chain.js";
import { timelineTool } from "./timeline.js";

export const allTools: ToolDef<unknown>[] = [
  // Read — graph traversal
  decisionGetTool as ToolDef<unknown>,
  decisionsInScopeTool as ToolDef<unknown>,
  decisionsForSymbolTool as ToolDef<unknown>,
  canonicalForTopicTool as ToolDef<unknown>,
  groundGetTool as ToolDef<unknown>,
  supersedesChainTool as ToolDef<unknown>,
  invariantGetTool as ToolDef<unknown>,
  invariantsInScopeTool as ToolDef<unknown>,
  // Read — 3-layer progressive
  searchTool as ToolDef<unknown>,
  timelineTool as ToolDef<unknown>,
  getFullTool as ToolDef<unknown>,
  // Read — historical (gated)
  queryHistoryTool as ToolDef<unknown>,
  // Write
  appendTool as ToolDef<unknown>,
  recordDecisionTool as ToolDef<unknown>,
  recordRunEventTool as ToolDef<unknown>,
  dropTaskTool as ToolDef<unknown>,
  archiveTool as ToolDef<unknown>,
];

export type { ToolDef };
