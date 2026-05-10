import type { ToolDef } from "./types.js";
import { alignDrainTool } from "./align-drain.js";
import { archiveTool } from "./archive.js";
import { attentionDedupTool } from "./attention-dedup.js";
import { attentionRestoreTool } from "./attention-restore.js";
import { attentionServeTool } from "./attention-serve.js";
import { attentionWaitTool } from "./attention-wait.js";
import { bootstrapRetryTool } from "./bootstrap-retry.js";
import { bulkAcceptAttentionTool } from "./bulk-accept-attention.js";
import { canonicalForTopicTool } from "./canonical-for-topic.js";
import { decisionGetTool } from "./decision-get.js";
import { decisionsForSymbolTool } from "./decisions-for-symbol.js";
import { getFullTool } from "./get-full.js";
import { groundGetTool } from "./ground-get.js";
import { inScopeTool } from "./in-scope.js";
import {
  initResumeTool,
  initRunTool,
} from "./init-phases.js";
import { missionStartTool } from "./mission-start.js";
import { missionAcceptDraftTool } from "./mission-accept-draft.js";
import { missionGetTool } from "./mission-get.js";
import { missionAdvanceTool } from "./mission-advance.js";
import { missionCloseTool } from "./mission-close.js";
import { missionResumeTool } from "./mission-resume.js";
import { missionResyncTool } from "./mission-resync.js";
import { missionResyncAcceptTool } from "./mission-resync-accept.js";
import { missionReopenTool } from "./mission-reopen.js";
import { invariantGetTool } from "./invariant-get.js";
import { queryHistoryTool } from "./query-history.js";
import { recordDecisionTool } from "./record-decision.js";
import { rejectCandidateTool } from "./reject-candidate.js";
import { resolveAttentionTool } from "./resolve-attention.js";
import { searchTool } from "./search.js";
import { searchCandidatesTool } from "./search-candidates.js";
import { supersedesChainTool } from "./supersedes-chain.js";
import { resumeTool } from "./resume.js";
import { taskCompleteTool } from "./task-complete.js";
import { taskCreateTool } from "./task-create.js";
import { taskJournalAppendTool } from "./task-journal-append.js";
import { timelineTool } from "./timeline.js";

export const allTools: ToolDef<never>[] = [
  // Read — graph traversal
  decisionGetTool,
  decisionsForSymbolTool,
  canonicalForTopicTool,
  groundGetTool,
  supersedesChainTool,
  invariantGetTool,
  inScopeTool,
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
  taskCompleteTool,
  taskJournalAppendTool,
  archiveTool,
  // Read — resume layer
  resumeTool,
  // Write — phase 6 candidate surface
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
  missionCloseTool,
  missionResumeTool,
  missionResyncTool,
  missionResyncAcceptTool,
  missionReopenTool,
];

export type { ToolDef };
