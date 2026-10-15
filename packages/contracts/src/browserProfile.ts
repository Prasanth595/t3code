/**
 * Profiles are client-local, like the other browser defaults, because the
 * Chromium guest they configure is desktop-local.
 * - `default` keeps the partition scope the browser used before profiles
 *   existed, so upgrading does not sign anyone out.
 */
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;
export const BROWSER_PROFILE_MAX_COUNT = 24;

/**
 * Control characters are rejected because ids are folded into delimiter-joined
 * cache keys on the client; one carrying the delimiter would resolve to a
 * different profile's partition.
 */
export const BrowserProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export type BrowserProfileId = typeof BrowserProfileId.Type;

export const BrowserProfileName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BROWSER_PROFILE_NAME_MAX_LENGTH),
);

/**
 * `persistent` profiles keep cookies on disk across restarts; `incognito`
 * uses an in-memory partition that Chromium discards with the process.
 */
export const BrowserProfileKind = Schema.Literals(["persistent", "incognito"]);
export type BrowserProfileKind = typeof BrowserProfileKind.Type;

export const BrowserProfile = Schema.Struct({
  id: BrowserProfileId,
  name: BrowserProfileName,
  kind: BrowserProfileKind,
});
export type BrowserProfile = typeof BrowserProfile.Type;

export const DEFAULT_BROWSER_PROFILE_ID: BrowserProfileId = "default";
export const INCOGNITO_BROWSER_PROFILE_ID: BrowserProfileId = "incognito";

/**
 * Built-ins are synthesized rather than stored, so they cannot be renamed out
 * of existence or deleted by editing the settings file by hand.
 */
export const BUILT_IN_BROWSER_PROFILES: ReadonlyArray<BrowserProfile> = [
  { id: DEFAULT_BROWSER_PROFILE_ID, name: "Default", kind: "persistent" },
  { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Incognito", kind: "incognito" },
];

export function isBuiltInBrowserProfileId(id: string): boolean {
  return BUILT_IN_BROWSER_PROFILES.some((profile) => profile.id === id);
}

/**
 * - Repeated ids, which map to one partition and would otherwise appear as
 *   two isolated identities sharing every cookie. First entry wins.
 * - `kind: "incognito"` on anything but the built-in, since persistence is
 *   keyed off that one id; such a profile is labelled ephemeral while its
 *   cookies survive restarts.
 */
export function resolveBrowserProfiles(
  userProfiles: ReadonlyArray<BrowserProfile>,
): ReadonlyArray<BrowserProfile> {
  const seen = new Set(BUILT_IN_BROWSER_PROFILES.map((profile) => profile.id));
  const resolved = [...BUILT_IN_BROWSER_PROFILES];
  for (const profile of userProfiles) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    resolved.push(profile.kind === "persistent" ? profile : { ...profile, kind: "persistent" });
  }
  return resolved;
}

export function findBrowserProfile(
  profiles: ReadonlyArray<BrowserProfile>,
  id: string | undefined,
): BrowserProfile | undefined {
  return id === undefined ? undefined : profiles.find((profile) => profile.id === id);
}
