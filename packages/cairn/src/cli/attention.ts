/**
 * `cairn attention` — show pending operator review items.
 *
 * Reads two sources from the adopted project:
 *   1. `.cairn/ground/decisions/_inbox/*.draft.md`  — DEC drafts awaiting confirm
 *   2. `.cairn/baseline/sensor-audit-*.yaml` (latest) — pre-Cairn sensor findings
 *
 * Prints a structured summary; exits 0 when there are no pending items, 2 when
 * any are present (so scripts can branch on attention).
 */

import {
  type Dirent,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { spawn } from "node:child_process";
import {
  bulkAcceptObvious,
  parseFrontmatterRecord,
  restoreDec,
  runAttentionUndo,
  startAttentionServer,
  type BulkAcceptResult,
  type DraftConfidence,
  type UndoArgs,
  type UndoResult,
} from "@isaacriehm/cairn-core";
import type { ProjectGlobs } from "@isaacriehm/cairn-core";

interface DraftEntry {
  id: string;
  title: string;
  sourceFile: string | null;
  captureSource: string | null;
  rationale: string | null;
}

interface BaselineFinding {
  sensor_id: string;
  path: string;
  line: number;
  message: string;
  severity: "hard" | "soft";
}

interface BaselineSummary {
  path: string;
  runAt: string | null;
  totalFindings: number;
  filesScanned: number;
  bySensor: Map<string, BaselineFinding[]>;
}

const FINDINGS_PER_SENSOR = 3;

function parseRepoFlag(argv: string[]): string {
  const idx = argv.indexOf("--repo");
  if (idx === -1) return process.cwd();
  const candidate = argv[idx + 1];
  if (candidate === undefined || candidate.startsWith("--")) {
    console.error("--repo requires a path argument");
    process.exit(2);
  }
  return resolve(candidate);
}

function ensureAdopted(repoRoot: string): void {
  if (!existsSync(repoRoot)) {
    console.error(`cairn attention: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }
  if (!existsSync(`${repoRoot}/.cairn`)) {
    console.error(
      `cairn attention: ${repoRoot} is not cairn-adopted (no .cairn/). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }
}

function readFrontmatter(text: string): Record<string, unknown> {
  // Reuse the canonical CRLF-tolerant parser so a draft saved with Windows
  // line endings still keys correctly (single source of frontmatter truth).
  return parseFrontmatterRecord(text).fm;
}

function listDrafts(repoRoot: string): DraftEntry[] {
  const dir = join(repoRoot, ".cairn", "ground", "decisions", "_inbox");
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const out: DraftEntry[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".draft.md")) continue;
    const abs = join(dir, e.name);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const fm = readFrontmatter(text);
    const id =
      typeof fm["id"] === "string"
        ? (fm["id"] as string)
        : e.name.replace(/\.draft\.md$/, "");
    const title =
      typeof fm["title"] === "string"
        ? (fm["title"] as string)
        : "(untitled draft)";
    const sourceFile =
      typeof fm["sourceFile"] === "string" ? (fm["sourceFile"] as string) : null;
    const captureSource =
      typeof fm["capture_source"] === "string"
        ? (fm["capture_source"] as string)
        : null;
    const rationale =
      typeof fm["proposedRationale"] === "string"
        ? (fm["proposedRationale"] as string)
        : null;
    out.push({ id, title, sourceFile, captureSource, rationale });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

import { z } from "zod";

const BaselineFindingSchema = z.object({
  path: z.string().optional(),
  line: z.number().optional(),
  message: z.string().optional(),
  severity: z.enum(["hard", "soft"]).optional(),
}).passthrough();

const BaselineSensorSchema = z.object({
  sensor_id: z.string().optional(),
  findings: z.array(BaselineFindingSchema).optional(),
}).passthrough();

const BaselineAuditSchema = z.object({
  run_at: z.string().optional(),
  total_findings: z.number().optional(),
  files_scanned: z.number().optional(),
  sensors: z.array(BaselineSensorSchema).optional(),
}).passthrough();

function readLatestBaseline(repoRoot: string): BaselineSummary | null {
  const dir = join(repoRoot, ".cairn", "baseline");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: "utf8" });
  } catch {
    return null;
  }
  const matching = entries
    .filter((name) => /^sensor-audit-.*\.yaml$/.test(name))
    .sort();
  const latest = matching.at(-1);
  if (latest === undefined) return null;
  const abs = join(dir, latest);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  const result = BaselineAuditSchema.safeParse(parsed);
  if (!result.success) return null;
  
  const obj = result.data;
  const runAt = obj.run_at ?? null;
  const totalFindings = obj.total_findings ?? 0;
  const filesScanned = obj.files_scanned ?? 0;
  const bySensor = new Map<string, BaselineFinding[]>();
  if (obj.sensors !== undefined) {
    for (const r of obj.sensors) {
      const sensorId = r.sensor_id ?? "";
      if (sensorId.length === 0) continue;
      const findingsRaw = r.findings ?? [];
      const findings: BaselineFinding[] = [];
      for (const fr of findingsRaw) {
        findings.push({
          sensor_id: sensorId,
          path: fr.path ?? "",
          line: fr.line ?? 0,
          message: fr.message ?? "",
          severity: fr.severity === "hard" ? "hard" : "soft",
        });
      }
      if (findings.length > 0) bySensor.set(sensorId, findings);
    }
  }
  return {
    path: abs.startsWith(repoRoot) ? abs.slice(repoRoot.length + 1) : abs,
    runAt,
    totalFindings,
    filesScanned,
    bySensor,
  };
}

function shortenAge(iso: string | null): string {
  if (iso === null) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.floor((Date.now() - t) / 60_000);
  if (minutes < 60) return ` (${minutes}m ago)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ` (${hours}h ago)`;
  const days = Math.floor(hours / 24);
  return ` (${days}d ago)`;
}

function renderDraftsSection(drafts: DraftEntry[]): void {
  process.stdout.write(
    `  Decision drafts pending confirm — ${drafts.length}\n`,
  );
  for (const d of drafts) {
    const tag = d.captureSource !== null ? ` [${d.captureSource}]` : "";
    process.stdout.write(`    • ${d.id}${tag}  ${d.title}\n`);
    if (d.sourceFile !== null) {
      process.stdout.write(`        from ${d.sourceFile}\n`);
    }
    if (d.rationale !== null && d.rationale.length > 0) {
      const cap = d.rationale.length > 140 ? `${d.rationale.slice(0, 137)}…` : d.rationale;
      process.stdout.write(`        ${cap}\n`);
    }
  }
  process.stdout.write(
    "\n  Edit, accept, or discard each draft, then run `cairn attention` again.\n",
  );
}

function renderBaselineSection(summary: BaselineSummary): void {
  const age = shortenAge(summary.runAt);
  process.stdout.write(
    `  Baseline sensor findings — ${summary.totalFindings} (across ${summary.filesScanned} files)${age}\n`,
  );
  process.stdout.write(`    audit: ${summary.path}\n`);
  for (const [sensorId, findings] of summary.bySensor) {
    process.stdout.write(`    ${sensorId} — ${findings.length}\n`);
    const head = findings.slice(0, FINDINGS_PER_SENSOR);
    for (const f of head) {
      const loc = f.line > 0 ? `:${f.line}` : "";
      const msg = f.message.length > 80 ? `${f.message.slice(0, 77)}…` : f.message;
      process.stdout.write(`      ${f.path}${loc}  ${msg}\n`);
    }
    if (findings.length > head.length) {
      process.stdout.write(
        `      …${findings.length - head.length} more\n`,
      );
    }
  }
  process.stdout.write(
    "\n  These are pre-Cairn violations. Address them before starting new work, or accept as debt.\n",
  );
}

function parseThresholdFlag(argv: string[]): DraftConfidence {
  const idx = argv.indexOf("--threshold");
  if (idx === -1) return "high";
  const v = argv[idx + 1];
  if (v === "high" || v === "medium" || v === "low") return v;
  console.error(`--threshold must be high|medium|low, got ${String(v)}`);
  process.exit(2);
}

function loadProjectGlobs(repoRoot: string): { globs: ProjectGlobs } {
  const configPath = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(configPath)) {
    return { globs: {} };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    return { globs: {} };
  }
  if (typeof parsed !== "object" || parsed === null) return { globs: {} };
  const cfg = parsed as Record<string, unknown>;
  const globs: ProjectGlobs = {};
  const pickList = (key: string): string[] | undefined => {
    const v = cfg[key];
    if (!Array.isArray(v)) return undefined;
    return v.filter((x): x is string => typeof x === "string");
  };
  const high = pickList("high_stakes_globs");
  if (high !== undefined) globs.high_stakes_globs = high;
  const off = pickList("off_limits");
  if (off !== undefined) globs.off_limits = off;
  const projectGlobs = cfg["project_globs"];
  if (typeof projectGlobs === "object" && projectGlobs !== null) {
    const pg = projectGlobs as Record<string, unknown>;
    const route = Array.isArray(pg["route_handler_globs"])
      ? (pg["route_handler_globs"].filter((x) => typeof x === "string") as string[])
      : undefined;
    if (route !== undefined) globs.route_handler_globs = route;
    const dto = Array.isArray(pg["dto_globs"])
      ? (pg["dto_globs"].filter((x) => typeof x === "string") as string[])
      : undefined;
    if (dto !== undefined) globs.dto_globs = dto;
    const gen = Array.isArray(pg["generator_source_globs"])
      ? (pg["generator_source_globs"].filter((x) => typeof x === "string") as string[])
      : undefined;
    if (gen !== undefined) globs.generator_source_globs = gen;
    const hi = Array.isArray(pg["high_stakes_globs"])
      ? (pg["high_stakes_globs"].filter((x) => typeof x === "string") as string[])
      : undefined;
    if (hi !== undefined && globs.high_stakes_globs === undefined) {
      globs.high_stakes_globs = hi;
    }
  }
  return { globs };
}

function renderBulkAcceptResult(
  result: BulkAcceptResult,
  threshold: DraftConfidence,
): void {
  const mode = result.dryRun ? "  [dry-run] " : "  ";
  process.stdout.write(
    `${mode}DEC drafts scanned: ${result.decsScanned}\n`,
  );
  process.stdout.write(
    `    high: ${result.decsByConfidence.high}, medium: ${result.decsByConfidence.medium}, low: ${result.decsByConfidence.low}\n`,
  );
  if (result.dryRun) {
    process.stdout.write(
      `    would accept (≥${threshold}): ${result.decsAccepted}\n`,
    );
  } else {
    process.stdout.write(
      `    accepted (≥${threshold}): ${result.decsAccepted}\n`,
    );
  }
  process.stdout.write(
    `${mode}invariants scanned: ${result.invariantsScanned}\n`,
  );
  process.stdout.write(
    `    high: ${result.invariantsByConfidence.high}, medium: ${result.invariantsByConfidence.medium}, low: ${result.invariantsByConfidence.low}\n`,
  );
  if (!result.dryRun) {
    const remaining = result.decsScanned - result.decsAccepted;
    process.stdout.write(
      `\n  ${remaining} DEC draft(s) remain in _inbox/ for triage.\n` +
        `  Run \`cairn attention\` (no flags) to see them, or open the inbox dir directly.\n`,
    );
  }
}

async function restoreCli(repoRoot: string, argv: string[]): Promise<void> {
  const decId = argv.find((a) => /^DEC-[0-9a-f]{7,}$/.test(a));
  if (decId === undefined) {
    console.error(
      "cairn attention restore: missing or invalid DEC id (expected DEC-<hash7>)",
    );
    process.exit(2);
  }
  const result = await restoreDec({ repoRoot, decId });
  if (!result.ok) {
    process.stdout.write(
      `  ✗ ${decId} — ${result.reason ?? "unknown"} (state: ${result.priorState})\n`,
    );
    process.exit(2);
  }
  if (result.priorState === "draft") {
    process.stdout.write(
      `  · ${decId} — already a draft (no-op); rerun cairn-attention to triage\n`,
    );
    process.exit(0);
  }
  const note =
    result.priorState === "accepted"
      ? "ledger rebuilt, inline `// §DEC-NNNN` source cite kept"
      : "no source-cite impact";
  process.stdout.write(
    `  ✓ ${decId} — restored from ${result.priorState} → ${result.draftPath} (${note})\n` +
      `\n  Run cairn-attention (or cairn_resolve_attention) to re-triage.\n`,
  );
  process.exit(0);
}

function parseDurationToMs(raw: string): number | null {
  const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (m === null) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] ?? "h";
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return null;
  }
}

function renderUndoSummary(result: UndoResult): string {
  const lines: string[] = [];
  lines.push(`    entries in window:        ${result.windowEntries}`);
  lines.push(`    entries outside window:   ${result.outsideWindow}`);
  lines.push(`    reverted:                 ${result.reverted}`);
  lines.push(`    already reverted:         ${result.alreadyReverted}`);
  lines.push(`    not supported (deferred): ${result.notSupported}`);
  lines.push(`    source missing:           ${result.sourceMissing}`);
  lines.push(`    errors:                   ${result.errors}`);
  if (result.outcomes.length > 0) {
    lines.push("");
    lines.push("  per-entry:");
    for (const o of result.outcomes) {
      const tag = o.status.padEnd(18, " ");
      lines.push(`    ${tag} ${o.entry.kind} ${o.entry.file} → ${o.entry.primary_id}`);
      if (o.detail !== undefined) lines.push(`      ${o.detail}`);
    }
  }
  return lines.join("\n");
}

async function undoCli(repoRoot: string, argv: string[]): Promise<void> {
  let sinceMs: number | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--since requires a duration (e.g. 30m, 2h, 1d)");
        process.exit(2);
      }
      const ms = parseDurationToMs(v);
      if (ms === null) {
        console.error(`--since invalid: ${v} (expected NNh / NNm / NNd / NNs / NNms)`);
        process.exit(2);
      }
      sinceMs = ms;
      i += 1;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--repo") {
      i += 1;
    } else {
      console.error(`cairn attention undo: unknown flag "${a}"`);
      process.exit(2);
    }
  }
  const args: UndoArgs = { repoRoot };
  if (sinceMs !== null) args.sinceMs = sinceMs;
  if (dryRun) args.dryRun = true;
  process.stdout.write(
    `  ⬡ cairn attention undo${dryRun ? " --dry-run" : ""} — ${repoRoot}\n` +
      `    since:                    ${sinceMs ?? 3_600_000}ms\n\n`,
  );
  const result = await runAttentionUndo(args);
  process.stdout.write(`${renderUndoSummary(result)}\n`);
  if (dryRun) {
    process.stdout.write(`\n  Dry-run complete. Re-run without --dry-run to apply.\n`);
  } else {
    process.stdout.write(
      `\n  Undo log pruned. Run again with a larger --since to undo older entries.\n`,
    );
  }
  process.exit(result.errors > 0 ? 2 : 0);
}

async function bulkAcceptCli(repoRoot: string, argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const threshold = parseThresholdFlag(argv);
  const { globs } = loadProjectGlobs(repoRoot);
  const result = await bulkAcceptObvious({
    repoRoot,
    globs,
    threshold,
    dryRun,
  });
  process.stdout.write(`  ⬡ cairn attention bulk-accept — ${repoRoot}\n\n`);
  renderBulkAcceptResult(result, threshold);
  process.exit(0);
}

async function serveCli(repoRoot: string, argv: string[]): Promise<void> {
  const portIdx = argv.indexOf("--port");
  const port =
    portIdx >= 0 && argv[portIdx + 1] !== undefined
      ? Number.parseInt(argv[portIdx + 1] as string, 10)
      : 0;
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    console.error(`--port must be 0-65535, got ${argv[portIdx + 1]}`);
    process.exit(2);
  }
  const noOpen = argv.includes("--no-open");
  const idleIdx = argv.indexOf("--idle-timeout-min");
  const idleTimeoutMs =
    idleIdx >= 0 && argv[idleIdx + 1] !== undefined
      ? Number.parseInt(argv[idleIdx + 1] as string, 10) * 60_000
      : undefined;

  const handle = await startAttentionServer({
    repoRoot,
    port,
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  });
  process.stdout.write(
    `  ⬡ cairn attention serve — ${repoRoot}\n` +
      `    listening on ${handle.url}\n` +
      `    sentinel:    ${handle.sentinelPath}\n`,
  );
  if (!noOpen) {
    try {
      if (process.platform === "win32") {
        // `start` is a cmd builtin, not an executable — route through cmd.
        // The empty "" is start's window-title arg; without it start treats
        // the quoted URL as the title and opens a blank console.
        spawn("cmd", ["/c", "start", "", handle.url], {
          stdio: "ignore",
          detached: true,
        }).unref();
      } else {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(opener, [handle.url], {
          stdio: "ignore",
          detached: true,
        }).unref();
      }
    } catch {
      /* if open fails, operator clicks the URL manually */
    }
  }
  process.on("SIGINT", () => {
    handle.close().then(() => process.exit(0));
  });
  const state = await handle.done;
  process.stdout.write(
    `  ✓ triage ${state.reason} — accepted ${state.accepted} · rejected ${state.rejected} · merged ${state.merged} · edited ${state.edited}\n`,
  );
  process.exit(0);
}

export async function attentionCli(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      "Usage: cairn attention [--repo <path>]\n" +
        "       cairn attention bulk-accept [--threshold high|medium|low] [--dry-run] [--repo <path>]\n" +
        "       cairn attention restore <DEC-id> [--repo <path>]\n" +
        "       cairn attention serve [--port <n>] [--no-open] [--idle-timeout-min <n>] [--repo <path>]\n" +
        "       cairn attention undo [--since <duration>] [--dry-run] [--repo <path>]\n" +
        "  Default: list DEC drafts pending confirm + latest baseline sensor findings.\n" +
        "  bulk-accept: score drafts by confidence, auto-promote ≥threshold (default high)\n" +
        "    out of _inbox/ to .cairn/ground/decisions/, and stamp\n" +
        "    capture_confidence on every draft + invariant. Threshold low effectively\n" +
        "    accepts all drafts; only use after reviewing the dry-run output.\n" +
        "  restore: move a previously rejected or accepted DEC back to _inbox/<id>.draft.md\n" +
        "    so the operator can re-evaluate via cairn-attention. Accepted-to-draft\n" +
        "    keeps the inline `// §DEC-<hash>` source cite (re-accept is idempotent).\n" +
        "  serve: launch the browser triage UI on 127.0.0.1:<port>. Default port = OS-assigned.\n" +
        "    Auto-opens the browser unless --no-open. Blocks until the operator clicks Done\n" +
        "    or the server idles out (default 10 min). Writes a sentinel at\n" +
        "    .cairn/cache/attention-done.json on exit.\n" +
        "  undo: revert recent Layer A auto-resolutions logged at\n" +
        "    .cairn/state/align-undo-log.jsonl. --since accepts NNms / NNs / NNm / NNh / NNd\n" +
        "    (default 1h). Currently reverts tier1-cite + tier2-cite. tier3-creation /\n" +
        "    augments-sibling undo is reported as not-supported (manual surgery for now).\n" +
        "  Exit 0 when nothing pending or after bulk-accept/restore/serve/undo; 2 when any items remain.\n",
    );
    process.exit(0);
  }

  if (argv[0] === "bulk-accept") {
    const rest = argv.slice(1);
    const repoRoot = parseRepoFlag(rest);
    ensureAdopted(repoRoot);
    await bulkAcceptCli(repoRoot, rest);
    return;
  }

  if (argv[0] === "undo") {
    const rest = argv.slice(1);
    const repoRoot = parseRepoFlag(rest);
    ensureAdopted(repoRoot);
    await undoCli(repoRoot, rest);
    return;
  }

  if (argv[0] === "restore") {
    const rest = argv.slice(1);
    const repoRoot = parseRepoFlag(rest);
    ensureAdopted(repoRoot);
    await restoreCli(repoRoot, rest);
    return;
  }

  if (argv[0] === "serve") {
    const rest = argv.slice(1);
    const repoRoot = parseRepoFlag(rest);
    ensureAdopted(repoRoot);
    await serveCli(repoRoot, rest);
    return;
  }

  const repoRoot = parseRepoFlag(argv);
  ensureAdopted(repoRoot);

  const drafts = listDrafts(repoRoot);
  const baseline = readLatestBaseline(repoRoot);

  process.stdout.write(`  ⬡ cairn attention — ${repoRoot}\n\n`);

  if (drafts.length === 0 && (baseline === null || baseline.totalFindings === 0)) {
    process.stdout.write("  Nothing pending. Project brain is up to date.\n");
    process.exit(0);
  }

  if (drafts.length > 0) {
    renderDraftsSection(drafts);
  }
  if (baseline !== null && baseline.totalFindings > 0) {
    if (drafts.length > 0) process.stdout.write("\n");
    renderBaselineSection(baseline);
  }
  process.exit(2);
}
