import type { ToolDef } from "./types.js";
import { attentionDedupTool } from "./attention-dedup.js";
import { attentionServeTool } from "./attention-serve.js";
import { attentionWaitTool } from "./attention-wait.js";
import { bootstrapRetryTool } from "./bootstrap-retry.js";
import { bulkAcceptAttentionTool } from "./bulk-accept-attention.js";
import { canonicalForTopicTool } from "./canonical-for-topic.js";
import { decisionGetTool } from "./decision-get.js";
import { inScopeTool } from "./in-scope.js";
import {
  initResumeTool,
  initRunTool,
} from "./init-phases.js";
import { missionStartTool } from "./mission-start.js";
import { missionAcceptDraftTool } from "./mission-accept-draft.js";
import { missionGetTool } from "./mission-get.js";
import { missionAdvanceTool } from "./mission-advance.js";
import { missionResumeTool } from "./mission-resume.js";
import { missionResyncTool } from "./mission-resync.js";
import { missionResyncAcceptTool } from "./mission-resync-accept.js";
import { missionSetExitGateTool } from "./mission-set-exit-gate.js";
import { invariantGetTool } from "./invariant-get.js";
import { queryHistoryTool } from "./query-history.js";
import { recordDecisionTool } from "./record-decision.js";
import { resolveAttentionTool } from "./resolve-attention.js";
import { searchTool } from "./search.js";
import { resumeTool } from "./resume.js";
import { taskCompleteTool } from "./task-complete.js";
import { taskCreateTool } from "./task-create.js";
import { taskJournalAppendTool } from "./task-journal-append.js";
import { taskReopenTool } from "./task-reopen.js";

export const allTools: ToolDef<never>[] = [
  // Read — graph traversal
  decisionGetTool,
  canonicalForTopicTool,
  invariantGetTool,
  inScopeTool,
  // Read — search + retrieval
  searchTool,
  // Read — historical (gated)
  queryHistoryTool,
  // Write
  recordDecisionTool,
  taskCreateTool,
  taskCompleteTool,
  taskReopenTool,
  taskJournalAppendTool,
  // Read — resume layer
  resumeTool,
  // Write — plugin-era attention queue
  resolveAttentionTool,
  bulkAcceptAttentionTool,
  attentionDedupTool,
  attentionServeTool,
  attentionWaitTool,
  // Write — bootstrap recovery (replaces CLI exposure in BOOTSTRAP_REQUIRED)
  bootstrapRetryTool,
  // Write — init pipeline (v0.7.2 single-umbrella surface)
  initResumeTool,
  initRunTool,
  // Mission system — supra-task layer
  missionStartTool,
  missionAcceptDraftTool,
  missionGetTool,
  missionAdvanceTool,
  missionResumeTool,
  missionResyncTool,
  missionResyncAcceptTool,
  missionSetExitGateTool,
];

export type { ToolDef };
