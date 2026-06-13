import type { ToolDef } from "./types.js";
import { attentionDedupTool } from "./attention-dedup.js";
import { bootstrapRetryTool } from "./bootstrap-retry.js";
import { canonicalForTopicTool } from "./canonical-for-topic.js";
import { componentAnnotateTool } from "./component-annotate.js";
import { componentGetTool } from "./component-get.js";
import { componentRegisterTool } from "./component-register.js";
import { componentReconfirmTool } from "./component-reconfirm.js";
import { componentsInScopeTool } from "./components-in-scope.js";
import { decisionGetTool } from "./decision-get.js";
import { inScopeTool } from "./in-scope.js";
import {
  initResumeTool,
  initRunTool,
} from "./init-phases.js";
import { missionStartTool } from "./mission-start.js";
import { missionAcceptDraftTool } from "./mission-accept-draft.js";
import { missionGetTool } from "./mission-get.js";
import { missionPlanPhaseTool } from "./mission-plan-phase.js";
import { missionAdvanceTool } from "./mission-advance.js";
import { missionResumeTool } from "./mission-resume.js";
import { missionResyncTool } from "./mission-resync.js";
import { missionResyncAcceptTool } from "./mission-resync-accept.js";
import { missionSetExitGateTool } from "./mission-set-exit-gate.js";
import { invariantGetTool } from "./invariant-get.js";
import { recordDecisionTool } from "./record-decision.js";
import { retireDecisionTool, retireInvariantTool } from "./retire-entity.js";
import { migrateTool } from "./migrate.js";
import { resyncTool } from "./resync.js";
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
  // Read — component registry
  componentsInScopeTool,
  componentGetTool,
  // Read — search + retrieval
  searchTool,
  // Write
  recordDecisionTool,
  // Write — entity retirement (the OUT path)
  retireDecisionTool,
  retireInvariantTool,
  // Write — apply pending review-class migrations inline
  migrateTool,
  // Write — resolve surfaced config drift into config.yaml edits (review-class)
  resyncTool,
  // Write — component registry (committed header + ghost §3.8.1)
  componentAnnotateTool,
  componentRegisterTool,
  componentReconfirmTool,
  taskCreateTool,
  taskCompleteTool,
  taskReopenTool,
  taskJournalAppendTool,
  // Read — resume layer
  resumeTool,
  // Write — plugin-era attention queue
  resolveAttentionTool,
  attentionDedupTool,
  // Write — bootstrap recovery (replaces CLI exposure in BOOTSTRAP_REQUIRED)
  bootstrapRetryTool,
  // Write — init pipeline (v0.7.2 single-umbrella surface)
  initResumeTool,
  initRunTool,
  // Mission system — supra-task layer
  missionStartTool,
  missionAcceptDraftTool,
  missionGetTool,
  missionPlanPhaseTool,
  missionAdvanceTool,
  missionResumeTool,
  missionResyncTool,
  missionResyncAcceptTool,
  missionSetExitGateTool,
];

export type { ToolDef };
