/**
 * PostToolUse hook handlers.
 *
 * Currently exposes the Read enricher (`runReadEnricher`) and its
 * helpers. Spec: docs/READ_ENRICHER_SPEC.md.
 */

export { runReadEnricher } from "./read-enricher.js";
export { scanCitations } from "./citation-scanner.js";
export type { ScannedCitations, CitationMatch } from "./citation-scanner.js";
export {
  getInvariantsLedger,
  lookupTask,
} from "./ledger-cache.js";
export type { LedgerSnapshot, TaskLookupResult } from "./ledger-cache.js";
export { buildLegend } from "./legend-builder.js";
export type { ScopeIndexHint } from "./legend-builder.js";
