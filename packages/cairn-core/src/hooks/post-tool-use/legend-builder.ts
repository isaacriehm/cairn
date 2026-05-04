/**
 * Renders the boxed citation legend that the read-enricher prepends to
 * the agent's view via Shape-B `additionalContext`. Per
 * READ_ENRICHER_SPEC §6.1 the legend includes a scope-index header
 * (decisions/invariants in scope) when one was found for the file.
 */

import type { ScannedCitations } from "./citation-scanner.js";
import type { LedgerSnapshot, TaskLookupResult } from "./ledger-cache.js";

export interface ScopeIndexHint {
  /** DEC-IDs in scope for the file. */
  decisions: string[];
  /** Invariant IDs in scope (e.g. "V0041"). */
  invariants: string[];
}

const TOP_BORDER = "┌─ harness citations ────────────────────────────┐";
const BOTTOM_BORDER = "└───────────────────────────────────────────┘";
const SIDE = "│";

function row(content: string): string {
  return `${SIDE} ${content}`;
}

export function buildLegend(
  matches: ScannedCitations,
  ledger: LedgerSnapshot | null,
  scopeHint: ScopeIndexHint | null,
  resolveTask: (taskId: string) => TaskLookupResult,
): string | null {
  const hasScopeHint =
    scopeHint !== null &&
    (scopeHint.decisions.length > 0 || scopeHint.invariants.length > 0);
  const hasCitations =
    matches.invariants.length > 0 ||
    matches.todos.length > 0 ||
    matches.decIds.length > 0;

  if (!hasScopeHint && !hasCitations) return null;

  const lines: string[] = [];
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

  for (const inv of matches.invariants) {
    lines.push(row(renderInvariant(inv.id, ledger)));
  }
  for (const todo of matches.todos) {
    lines.push(row(renderTodo(todo.id, resolveTask(todo.id))));
  }
  for (const dec of matches.decIds) {
    lines.push(
      row(`${dec.id} → [POLICY VIOLATION — DEC-id comments banned]`),
    );
  }

  lines.push(BOTTOM_BORDER);
  return lines.join("\n");
}

function renderInvariant(id: string, ledger: LedgerSnapshot | null): string {
  // id arrives as "V0023" — display with the §-prefix.
  const label = `§${id}`;
  if (ledger === null) {
    return `${label} → [NOT FOUND — orphaned citation, GC will flag]`;
  }
  const entry = ledger.invariantsByid.get(id);
  if (!entry) {
    return `${label} → [NOT FOUND — orphaned citation, GC will flag]`;
  }
  if (entry.superseded_by !== undefined && entry.superseded_by.length > 0) {
    const sup = entry.superseded_by.startsWith("V")
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

function renderTodo(id: string, result: TaskLookupResult): string {
  // id arrives as "TSK-<id>" — display in the TODO(...) form.
  const label = `TODO(${id})`;
  if (result.found === "not_found") {
    return `${label} → [NOT FOUND]`;
  }
  const title =
    result.title !== undefined && result.title.length > 0
      ? result.title
      : id;
  if (result.found === "done") {
    return `${label} → ${title}  [DONE — this TODO can be removed]`;
  }
  return `${label} → ${title}  [active]`;
}
