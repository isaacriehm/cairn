import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { anchorMapPath } from "./paths.js";
import { AnchorMap, type AnchorMapEntry } from "./schemas.js";

const log = logger("ground.anchor-map");

/**
 * Anchor-map is the external slug → location index for sot_kind=path
 * DECs. Operator's docs stay pristine: no `<!-- cairn-anchor: … -->`
 * comments are injected. When the operator renames a heading or moves a
 * paragraph, the anchor-map updates and §DEC-<hash> tokens stay valid
 * because they resolve through this map, not the literal heading slug.
 */

export function emptyAnchorMap(): AnchorMap {
  return { version: 1, generated: new Date().toISOString(), anchors: {} };
}

export function readAnchorMap(repoRoot: string): AnchorMap {
  const path = anchorMapPath(repoRoot);
  if (!existsSync(path)) return emptyAnchorMap();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = AnchorMap.safeParse(parseYaml(raw));
    if (!parsed.success) {
      log.warn({ path, error: parsed.error.message }, "anchor-map invalid; treating as empty");
      return emptyAnchorMap();
    }
    return parsed.data;
  } catch (err) {
    log.warn({ path, err }, "anchor-map read failed; treating as empty");
    return emptyAnchorMap();
  }
}

export function writeAnchorMap(repoRoot: string, map: AnchorMap): string {
  const path = anchorMapPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const next: AnchorMap = { ...map, generated: new Date().toISOString() };
  writeFileSync(path, stringifyYaml(next), "utf8");
  log.debug({ path, anchors: Object.keys(next.anchors).length }, "wrote anchor-map");
  return path;
}

export function setAnchor(map: AnchorMap, slug: string, entry: AnchorMapEntry): AnchorMap {
  return { ...map, anchors: { ...map.anchors, [slug]: entry } };
}

export function getAnchor(map: AnchorMap, slug: string): AnchorMapEntry | null {
  return map.anchors[slug] ?? null;
}

export function deleteAnchor(map: AnchorMap, slug: string): AnchorMap {
  if (map.anchors[slug] === undefined) return map;
  const anchors = { ...map.anchors };
  delete anchors[slug];
  return { ...map, anchors };
}
