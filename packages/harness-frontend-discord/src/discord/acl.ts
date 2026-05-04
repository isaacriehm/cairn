/**
 * Owner allowlist gate. Per `docs/WORKFLOW_GUIDE.md` ACL rules + operator
 * locked answer D2 (owner Discord user-id). Comma-separated env var.
 */
export function parseOwnerIds(raw: string | undefined): Set<string> {
  if (!raw || raw.trim().length === 0) return new Set();
  const ids = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) ids.add(trimmed);
  }
  return ids;
}

export function isOwner(allowlist: Set<string>, userId: string): boolean {
  return allowlist.has(userId);
}
