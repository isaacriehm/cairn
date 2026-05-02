import type { Profile } from "./types.js";
import { unknownProfile } from "./unknown.js";

/**
 * Profile registry. Order matters — earlier profiles win.
 *
 * `unknown` is always last; it detects unconditionally as the fallback.
 * Future profiles (typescript-next-nest, python-fastapi, rails, go, rust)
 * are added before `unknown`, in priority order.
 */
const profiles: Profile[] = [unknownProfile];

export function registerProfile(profile: Profile): void {
  if (profile.id === "unknown") {
    throw new Error("Cannot re-register the unknown profile");
  }
  // Insert before unknown.
  const insertAt = profiles.findIndex((p) => p.id === "unknown");
  profiles.splice(insertAt, 0, profile);
}

export function selectProfile(repoRoot: string): Profile {
  for (const profile of profiles) {
    if (profile.detect(repoRoot)) return profile;
  }
  return unknownProfile;
}

export function getProfile(id: string): Profile | null {
  return profiles.find((p) => p.id === id) ?? null;
}

export function listProfiles(): readonly Profile[] {
  return profiles;
}
