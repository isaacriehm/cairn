/**
 * Renders the boxed citation legend that the read-enricher prepends to
 * the agent's view via Shape-B `additionalContext`. Per
 * READ_ENRICHER_SPEC §6.1 the legend includes a scope-index header
 * (decisions/invariants in scope) when one was found for the file.
 */

import type { ScannedCitations } from "./citation-scanner.js";
import type {
  DecisionsLedgerSnapshot,
  LedgerSnapshot,
} from "@isaacriehm/cairn-state";

export interface ScopeIndexHint {
  /** DEC-IDs in scope for the file. */
  decisions: string[];
  /** Invariant IDs in scope (e.g. "INV-4141414"). */
  invariants: string[];
}

const TOP_BORDER = "┌─ cairn citations ────────────────────────────┐";
const BOTTOM_BORDER = "└───────────────────────────────────────────┘";
const SIDE = "│";

function row(content: string): string {
  return `${SIDE} ${content}`;
}

/**
 * `unpromotedCandidates` — count of topic-index entries whose
 * `sot_source` is the file the agent just Read and whose `dec_id` is
 * still null. Sourced via O(1) lookup against
 * `.cairn/ground/file-candidates-map.yaml`
 * When > 0 the legend prepends a curator hint so the agent knows it
 * can call `cairn_propose_decision({ slug })` to surface a passage
 * the operator has clearly committed to as a rule.
 */
export function buildLegend(
  matches: ScannedCitations,
  invariantsLedger: LedgerSnapshot | null,
  decisionsLedger: DecisionsLedgerSnapshot | null,
  scopeHint: ScopeIndexHint | null,
  unpromotedCandidates = 0,
): string | null {
  const hasScopeHint =
    scopeHint !== null &&
    (scopeHint.decisions.length > 0 || scopeHint.invariants.length > 0);
  const hasCitations =
    matches.invariants.length > 0 ||
    matches.decisions.length > 0;
  const hasCandidates = unpromotedCandidates >= 1;

  if (!hasScopeHint && !hasCitations && !hasCandidates) return null;

  const lines: string[] = [];

  if (hasCandidates) {
    // The candidate hint sits ABOVE the boxed citation legend so the
    // curator prompt is the first thing the agent sees on the file.
    // PR 2 §4.7 wording — locked in spec.
    const noun = unpromotedCandidates === 1 ? "candidate" : "candidates";
    lines.push(
      `⚠ This file has ${unpromotedCandidates} unpromoted topic-index ${noun}.`,
    );
    lines.push(
      "  If a passage states an active rule the operator has committed to,",
    );
    lines.push(
      "  call cairn_record_decision({ slug }) to surface it for operator review.",
    );
    lines.push(
      "  Do NOT propose for narrative, plans, or status content.",
    );
    if (hasScopeHint || hasCitations) lines.push("");
  }

  if (!hasScopeHint && !hasCitations) {
    return lines.join("\n");
  }

  lines.push(TOP_BORDER);

  if (
    scopeHint !== null &&
    Array.isArray(scopeHint.decisions) &&
    scopeHint.decisions.length > 0
  ) {
    lines.push(row(`Decisions in scope: ${scopeHint.decisions.join(", ")}`));
  }
  if (
    scopeHint !== null &&
    Array.isArray(scopeHint.invariants) &&
    scopeHint.invariants.length > 0
  ) {
    const formatted = scopeHint.invariants
      .map((v) => (v.startsWith("§") ? v : `§${v}`))
      .join(", ");
    lines.push(row(`Invariants in scope: ${formatted}`));
  }

  for (const dec of matches.decisions) {
    lines.push(row(renderDecision(dec.id, decisionsLedger)));
  }
  for (const inv of matches.invariants) {
    lines.push(row(renderInvariant(inv.id, invariantsLedger)));
  }

  lines.push(BOTTOM_BORDER);
  return lines.join("\n");
}

function renderDecision(
  id: string,
  ledger: DecisionsLedgerSnapshot | null,
): string {
  // id arrives as "DEC-<hash7>" — display with the §-prefix.
  const label = `§${id}`;
  if (ledger === null) {
    return `${label} → [NOT FOUND — orphaned citation, GC will flag]`;
  }
  const entry = ledger.decisionsByid.get(id);
  if (!entry) {
    return `${label} → [NOT FOUND — orphaned citation, GC will flag]`;
  }
  if (entry.superseded_by !== undefined && entry.superseded_by.length > 0) {
    const sup = entry.superseded_by.startsWith("DEC-")
      ? `§${entry.superseded_by}`
      : entry.superseded_by;
    return `${label} → [SUPERSEDED by ${sup} — update this citation]`;
  }
  if (entry.status === "superseded" || entry.status === "archived") {
    return `${label} → [${entry.status.toUpperCase()} — update this citation]`;
  }
  const title = entry.title.length > 0 ? entry.title : "(no title)";
  return `${label} → ${title}  [${entry.status}]`;
}

function renderInvariant(id: string, ledger: LedgerSnapshot | null): string {
  // id arrives as "INV-<hash7>" — display with the §-prefix.
  const label = `§${id}`;
  if (ledger === null) {
    return `${label} → [NOT FOUND — orphaned citation, GC will flag]`;
  }
  const entry = ledger.invariantsByid.get(id);
  if (!entry) {
    return `${label} → [NOT FOUND — orphaned citation, GC will flag]`;
  }
  if (entry.superseded_by !== undefined && entry.superseded_by.length > 0) {
    const sup = entry.superseded_by.startsWith("INV-")
      ? `§${entry.superseded_by}`
      : entry.superseded_by;
    return `${label} → [SUPERSEDED by ${sup} — update this citation]`;
  }
  if (entry.status === "superseded") {
    return `${label} → [SUPERSEDED — update this citation]`;
  }
  const title = entry.title.length > 0 ? entry.title : "(no title)";
  return `${label} → ${title}  [active]`;
}
