/**
 * 0008 — clean leaked adoption scaffolding from a project's committed `.cairn/`.
 *
 * The shipped templates leaked Cairn-internal strings into every adopter's
 * committed files that the seed never scrubbed:
 *   - workflow.md  : a "Project-extension placeholder" meta-comment describing
 *                    the template's OWN substitution (false the moment init
 *                    ran) + a dangling `docs/SYSTEM_OVERVIEW.md` pointer (a
 *                    Cairn-internal doc that never ships to adopters).
 *   - sensors.yaml : the "honest-agent invariants stack" framing — internal
 *                    jargon that means nothing in an adopter's repo.
 *   - .gitignore   : `PLUGIN_ARCHITECTURE §7/§17`, `docs/FILESYSTEM_LAYOUT.md`,
 *                    `spec §2.2` — references to Cairn-internal docs that
 *                    dangle in the adopter's tree.
 *   - git-hooks    : `Spec: PLUGIN_ARCHITECTURE §17 Layer 1` refs in the
 *                    commit-msg + post-commit hooks.
 *   - personas.yaml: a `DOCS_SPEC.md §3.4` shape ref written by an older
 *                    brand-setup path (the template itself is clean).
 *
 * Plus synthetic, template-author timestamps in workflow.md + the brand /
 * product files (`2026-05-02T…`, `2026-05-04T…`). A fake `verified-at` is one
 * the freshness system can't trust, so we replace each synthetic stamp with
 * the file's real git first-commit author-date — the true adoption time,
 * identical on every clone. If git can't resolve it (untracked / ghost) the
 * stamp is LEFT rather than fabricated (no clock value → no per-clone churn).
 *
 * The templates now ship clean; this converges existing repos to them.
 *
 * `safe` (not `review`): deterministic, zero-semantic cosmetic edits. The
 * comment scrubs carry none of the matched anchor text (idempotent), and the
 * timestamp swap is content-derived — whoever runs it first commits the
 * canonical clean file and every other clone's `detect()` short-circuits, so
 * there is no churn. Auto-applies on session open (cf. 0001/0004).
 *
 * Ships in 0.27.0 → `introducedIn` 0.27.0; every prior adopter re-evaluates on
 * upgrade. `detect()` carries correctness.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cairnDir } from "@isaacriehm/cairn-state";
import type { Migration, MigrationResult } from "../types.js";

/** A deterministic comment scrub: matched anchor never appears in `with`. */
interface Scrub {
  re: RegExp;
  with: string;
  label: string;
}

interface FileSpec {
  /** Path segments under `.cairn/`. */
  rel: string[];
  scrubs?: Scrub[];
  /** Replace synthetic template-author timestamps with the git add-date. */
  fixTimestamps?: boolean;
}

/** The leaked workflow.md block: a rule line, the placeholder meta-comment, a rule line. */
const LEAKED_BLOCK =
  /#[ ]*─{10,}\n# Project-extension placeholder\.[\s\S]*?#[ ]*─{10,}\n/;

/** Dangling pointer at a Cairn-internal doc that never ships to adopters. */
const DANGLING_DOC_REF =
  /\n+If you're looking for the daily flow, see `docs\/SYSTEM_OVERVIEW\.md` §4\.\n/;

/** Clean operator-facing workflow.md replacement — matches the shipped template. */
const CLEAN_BLOCK = [
  "# ──────────────────────────────────────────────────────────────────────────────",
  "# Project workflow extension — keyed by this project's slug. Carries the",
  "# `off_limits` denylist (paths Cairn must never touch) and the trust posture.",
  "# Seeded at adoption; extend `off_limits` with your own paths.",
  "# ──────────────────────────────────────────────────────────────────────────────",
  "",
].join("\n");

/** Exact synthetic literals the templates used to ship — only these are swapped. */
const SYNTHETIC_STAMPS = ["2026-05-02T13:19:00Z", "2026-05-04T00:00:00Z"] as const;

const FILES: readonly FileSpec[] = [
  {
    rel: ["config", "workflow.md"],
    scrubs: [
      { re: LEAKED_BLOCK, with: CLEAN_BLOCK, label: "placeholder meta-comment" },
      { re: DANGLING_DOC_REF, with: "\n", label: "dangling docs/ pointer" },
    ],
    fixTimestamps: true,
  },
  {
    rel: ["config", "sensors.yaml"],
    scrubs: [
      {
        re: / Layer A of the honest-agent invariants stack\./,
        with: "",
        label: "internal jargon (sensors.yaml)",
      },
    ],
  },
  {
    rel: [".gitignore"],
    scrubs: [
      { re: / Marked\n# GITIGNORED in docs\/FILESYSTEM_LAYOUT\.md\./, with: "", label: "FILESYSTEM_LAYOUT ref" },
      { re: / Spec: PLUGIN_ARCHITECTURE §7\./, with: "", label: "PLUGIN_ARCHITECTURE §7 ref" },
      { re: / \(per PLUGIN_ARCHITECTURE §7\)/, with: "", label: "PLUGIN_ARCHITECTURE §7 paren ref" },
      { re: / Per PLUGIN_ARCHITECTURE §17 Layer 1\./, with: "", label: "PLUGIN_ARCHITECTURE §17 ref" },
      { re: / in spec §2\.2/, with: "", label: "spec §2.2 ref" },
    ],
  },
  {
    rel: ["git-hooks", "commit-msg"],
    scrubs: [
      { re: /# Spec: PLUGIN_ARCHITECTURE §17 Layer 1\.\n#\n/, with: "", label: "commit-msg spec ref" },
    ],
  },
  {
    rel: ["git-hooks", "post-commit"],
    scrubs: [
      {
        re: /# Spec: PLUGIN_ARCHITECTURE §17 Layer 1 \(bypass tracking\)\.\n#\n/,
        with: "",
        label: "post-commit spec ref",
      },
    ],
  },
  {
    rel: ["ground", "product", "personas.yaml"],
    scrubs: [
      { re: /\n# See DOCS_SPEC\.md §3\.4 for shape\./, with: "", label: "personas DOCS_SPEC ref" },
    ],
  },
  { rel: ["ground", "brand", "overview.md"], fixTimestamps: true },
  { rel: ["ground", "brand", "voice.md"], fixTimestamps: true },
  { rel: ["ground", "product", "positioning.md"], fixTimestamps: true },
];

function readMaybe(abs: string): string | null {
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function hasSyntheticStamp(text: string): boolean {
  return SYNTHETIC_STAMPS.some((s) => text.includes(s));
}

/** Does this file still need any scrub or timestamp fix? */
function fileNeeds(spec: FileSpec, raw: string): boolean {
  if (spec.scrubs?.some((s) => s.re.test(raw))) return true;
  if (spec.fixTimestamps === true && hasSyntheticStamp(raw)) return true;
  return false;
}

/**
 * The author-date of the commit that first ADDED `repoRelPath` — the real
 * adoption time, stable across clones (author date, not committer date).
 * Null when git is unavailable or the file is untracked (e.g. ghost mode).
 */
function gitAddDateIso(repoRoot: string, repoRelPath: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "--diff-filter=A", "--follow", "--format=%aI", "-1", "--", repoRelPath],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const first = out.split("\n")[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

export const cleanAdoptionScaffolding: Migration = {
  id: "0008-clean-adoption-scaffolding",
  introducedIn: "0.27.0",
  describe:
    "Scrub leaked template scaffolding from a project's committed .cairn/ — internal-doc refs (PLUGIN_ARCHITECTURE/FILESYSTEM_LAYOUT/DOCS_SPEC/SYSTEM_OVERVIEW), the false-after-adoption 'Project-extension placeholder' comment, the 'honest-agent invariants stack' jargon — and replace synthetic template-author timestamps with each file's real git add-date so verified-at is trustworthy",
  class: "safe",
  detect(repoRoot: string): boolean {
    for (const spec of FILES) {
      const raw = readMaybe(cairnDir(repoRoot, ...spec.rel));
      if (raw !== null && fileNeeds(spec, raw)) return true;
    }
    return false;
  },
  apply(repoRoot: string): MigrationResult {
    const cleaned: string[] = [];

    for (const spec of FILES) {
      const abs = cairnDir(repoRoot, ...spec.rel);
      const raw = readMaybe(abs);
      if (raw === null) continue;

      let next = raw;
      for (const scrub of spec.scrubs ?? []) {
        if (scrub.re.test(next)) {
          next = next.replace(scrub.re, scrub.with);
          cleaned.push(scrub.label);
        }
      }

      if (spec.fixTimestamps === true && hasSyntheticStamp(next)) {
        // The git add-date is the real adoption time. In committed mode the
        // file is tracked at `.cairn/<rel>`; in ghost mode it lives out-of-repo
        // and is untracked, so this lookup naturally returns null → stamp left.
        const repoRel = [".cairn", ...spec.rel].join("/");
        const addDate = gitAddDateIso(repoRoot, repoRel);
        if (addDate !== null) {
          for (const synth of SYNTHETIC_STAMPS) {
            next = next.split(synth).join(addDate);
          }
          cleaned.push(`${spec.rel[spec.rel.length - 1]} timestamp`);
        }
        // git unresolved → leave the stamp; never fabricate a clock value.
      }

      if (next !== raw) {
        try {
          writeFileSync(abs, next, "utf8");
        } catch (err) {
          return {
            changed: false,
            detail: `failed to rewrite ${spec.rel.join("/")}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    if (cleaned.length === 0) {
      return { changed: false, detail: "no leaked adoption scaffolding found" };
    }
    return { changed: true, detail: `cleaned: ${cleaned.join(" + ")}` };
  },
};
