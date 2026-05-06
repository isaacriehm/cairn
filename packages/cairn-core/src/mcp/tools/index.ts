import type { ToolDef } from "./types.js";
import { archiveTool } from "./archive.js";
import { attentionDedupTool } from "./attention-dedup.js";
import { attentionRestoreTool } from "./attention-restore.js";
import { attentionServeTool } from "./attention-serve.js";
import { attentionWaitTool } from "./attention-wait.js";
import { bulkAcceptAttentionTool } from "./bulk-accept-attention.js";
import { canonicalForTopicTool } from "./canonical-for-topic.js";
import { decisionGetTool } from "./decision-get.js";
import { decisionsForSymbolTool } from "./decisions-for-symbol.js";
import { decisionsInScopeTool } from "./decisions-in-scope.js";
import { getFullTool } from "./get-full.js";
import { groundGetTool } from "./ground-get.js";
import {
  initParallel678Tool,
  initPhaseTools,
  initResumeTool,
} from "./init-phases.js";
import { invariantGetTool } from "./invariant-get.js";
import { invariantsInScopeTool } from "./invariants-in-scope.js";
import { queryHistoryTool } from "./query-history.js";
import { recordDecisionTool } from "./record-decision.js";
import { resolveAttentionTool } from "./resolve-attention.js";
import { searchTool } from "./search.js";
import { supersedesChainTool } from "./supersedes-chain.js";
import { taskCreateTool } from "./task-create.js";
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
  recordDecisionTool as ToolDef<unknown>,
  taskCreateTool as ToolDef<unknown>,
  archiveTool as ToolDef<unknown>,
  // Write — plugin-era
  resolveAttentionTool as ToolDef<unknown>,
  bulkAcceptAttentionTool as ToolDef<unknown>,
  attentionDedupTool as ToolDef<unknown>,
  attentionRestoreTool as ToolDef<unknown>,
  attentionServeTool as ToolDef<unknown>,
  attentionWaitTool as ToolDef<unknown>,
  // Write — init pipeline (v0.2.0 MCP-native init)
  initResumeTool as ToolDef<unknown>,
  initParallel678Tool as ToolDef<unknown>,
  ...(initPhaseTools as ToolDef<unknown>[]),
];

export type { ToolDef };
