import type { ToolDef } from "./types.js";
import { alignDrainTool } from "./align-drain.js";
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
import { proposeDecisionTool } from "./propose-decision.js";
import { queryHistoryTool } from "./query-history.js";
import { recordDecisionTool } from "./record-decision.js";
import { rejectCandidateTool } from "./reject-candidate.js";
import { resolveAttentionTool } from "./resolve-attention.js";
import { searchTool } from "./search.js";
import { searchCandidatesTool } from "./search-candidates.js";
import { supersedesChainTool } from "./supersedes-chain.js";
import { taskCreateTool } from "./task-create.js";
import { timelineTool } from "./timeline.js";

export const allTools: ToolDef<never>[] = [
  // Read — graph traversal
  decisionGetTool,
  decisionsInScopeTool,
  decisionsForSymbolTool,
  canonicalForTopicTool,
  groundGetTool,
  supersedesChainTool,
  invariantGetTool,
  invariantsInScopeTool,
  // Read — 3-layer progressive
  searchTool,
  timelineTool,
  getFullTool,
  // Read — historical (gated)
  queryHistoryTool,
  // Read — phase 6 candidate surface
  searchCandidatesTool,
  // Write
  recordDecisionTool,
  taskCreateTool,
  archiveTool,
  // Write — phase 6 candidate surface
  proposeDecisionTool,
  rejectCandidateTool,
  // Write — plugin-era
  resolveAttentionTool,
  bulkAcceptAttentionTool,
  attentionDedupTool,
  attentionRestoreTool,
  attentionServeTool,
  attentionWaitTool,
  // Write — Layer C SessionStart drain
  alignDrainTool,
  // Write — init pipeline (v0.2.0 MCP-native init)
  initResumeTool,
  initParallel678Tool,
  ...initPhaseTools,
];

export type { ToolDef };
