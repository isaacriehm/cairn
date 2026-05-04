/**
 * `harness attention` — show pending operator review items.
 *
 * Reads two sources from the adopted project:
 *   1. `.harness/ground/decisions/_inbox/*.draft.md`  — DEC drafts awaiting confirm
 *   2. `.harness/baseline/sensor-audit-*.yaml` (latest) — pre-Harness sensor findings
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
    console.error(`harness attention: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }
  if (!existsSync(`${repoRoot}/.harness`)) {
    console.error(
      `harness attention: ${repoRoot} is not harness-adopted (no .harness/). Run \`harness init\` first.`,
    );
    process.exit(2);
  }
}

function readFrontmatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m || m[1] === undefined) return {};
  try {
    const parsed = parseYaml(m[1]) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function listDrafts(repoRoot: string): DraftEntry[] {
  const dir = join(repoRoot, ".harness", "ground", "decisions", "_inbox");
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

function readLatestBaseline(repoRoot: string): BaselineSummary | null {
  const dir = join(repoRoot, ".harness", "baseline");
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
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const runAt = typeof obj["run_at"] === "string" ? (obj["run_at"] as string) : null;
  const totalFindings =
    typeof obj["total_findings"] === "number" ? (obj["total_findings"] as number) : 0;
  const filesScanned =
    typeof obj["files_scanned"] === "number" ? (obj["files_scanned"] as number) : 0;
  const bySensor = new Map<string, BaselineFinding[]>();
  if (Array.isArray(obj["sensors"])) {
    for (const raw of obj["sensors"]) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const sensorId = typeof r["sensor_id"] === "string" ? (r["sensor_id"] as string) : "";
      if (sensorId.length === 0) continue;
      const findingsRaw = Array.isArray(r["findings"]) ? r["findings"] : [];
      const findings: BaselineFinding[] = [];
      for (const f of findingsRaw) {
        if (typeof f !== "object" || f === null) continue;
        const fr = f as Record<string, unknown>;
        findings.push({
          sensor_id: sensorId,
          path: typeof fr["path"] === "string" ? (fr["path"] as string) : "",
          line: typeof fr["line"] === "number" ? (fr["line"] as number) : 0,
          message: typeof fr["message"] === "string" ? (fr["message"] as string) : "",
          severity:
            fr["severity"] === "hard" || fr["severity"] === "soft"
              ? (fr["severity"] as "hard" | "soft")
              : "soft",
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
    "\n  Edit, accept, or discard each draft, then run `harness attention` again.\n",
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
    "\n  These are pre-Harness violations. Address them before starting new work, or accept as debt.\n",
  );
}

export async function attentionCli(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      "Usage: harness attention [--repo <path>]\n" +
        "  Show DEC drafts pending confirm + latest baseline sensor findings.\n" +
        "  Exit 0 when nothing pending; 2 when any items are pending.\n",
    );
    process.exit(0);
  }

  const repoRoot = parseRepoFlag(argv);
  ensureAdopted(repoRoot);

  const drafts = listDrafts(repoRoot);
  const baseline = readLatestBaseline(repoRoot);

  process.stdout.write(`  ⬡ harness attention — ${repoRoot}\n\n`);

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
