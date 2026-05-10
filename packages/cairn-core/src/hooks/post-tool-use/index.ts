/**
 * PostToolUse hook handlers.
 *
 * Exposes the Read enricher (`runReadEnricher`), the Write guardian
 * (`runWriteGuardian`), and their shared helpers.
 * Spec: docs/READ_ENRICHER_SPEC.md.
 */

export { runReadEnricher } from "./read-enricher.js";
export { scanCitations } from "./citation-scanner.js";
export type { ScannedCitations, CitationMatch } from "./citation-scanner.js";
export { buildLegend } from "./legend-builder.js";
export type { ScopeIndexHint } from "./legend-builder.js";
export { runWriteGuardian, executeWriteGuardian } from "./write-guardian.js";
export { scanForCopyLeakage } from "./copy-scanner.js";
export type { CopyIssue } from "./copy-scanner.js";
export { readCopySafetyConfig } from "./allowlist-reader.js";
export type { CopySafetyConfig } from "./allowlist-reader.js";
export { alignFile, runSotAlign, executeSotAlign } from "./sot-align.js";
export type {
  AlignFileArgs,
  AlignFileResult,
  CreationVerdict,
  DedupVerdict,
} from "./sot-align.js";
export { runPostWriteHook } from "./post-write.js";
export { containsEssayClassShape, isMarkdownPath } from "../sot-align-common.js";
