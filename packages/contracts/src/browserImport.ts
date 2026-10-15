import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

const BROWSER_IMPORT_SOURCE_IDS = [
  "chrome",
  "edge",
  "brave",
  "vivaldi",
  "opera",
  "arc",
  "helium",
  "firefox",
  "safari",
] as const;

export const BrowserImportSourceId = Schema.Literals(BROWSER_IMPORT_SOURCE_IDS);
export type BrowserImportSourceId = typeof BrowserImportSourceId.Type;

/**
 * `needsKeychainApproval` and `browserRunning` are recoverable — the user
 * grants access or quits the browser. `unsupportedPlatform` is not: it covers
 * cases like Chrome on Windows, whose App-Bound Encryption is designed to stop
 * exactly this, and which we will not work around.
 */
export const BrowserImportUnavailableReason = Schema.Literals([
  "notInstalled",
  "needsKeychainApproval",
  "keychainItemMissing",
  "needsFullDiskAccess",
  "browserRunning",
  "unsupportedPlatform",
]);
export type BrowserImportUnavailableReason = typeof BrowserImportUnavailableReason.Type;

/**
 * A superset of the unavailable reasons: a source can pass the pre-flight
 * check and still fail, most often because the user declined the keychain
 * prompt the read triggers.
 */
export const BrowserImportFailureReason = Schema.Literals([
  ...BrowserImportUnavailableReason.literals,
  /** The operating system's keyring or its bundled reader is unavailable. */
  "keychainUnavailable",
  "unknownSource",
  /** The requested profile directory is not one the source reported. */
  "unknownSourceProfile",
  /** The target profile's Electron session could not be opened. */
  "sessionUnavailable",
  /**
   * The cookies were written, but the new profile could not be saved to
   * settings, so its partition was cleared again rather than left orphaned.
   */
  "profileNotSaved",
  /**
   * The cookies were written, but the profile count reached its cap while the
   * import ran, so the new profile was not saved and its partition was cleared.
   */
  "profileLimitReached",
  "readFailed",
]);
export type BrowserImportFailureReason = typeof BrowserImportFailureReason.Type;

export const BrowserImportSourceProfile = Schema.Struct({
  /** Directory name under the source's user-data dir. */
  directory: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /**
   * Counted without decrypting, so it is cheap; absent when the store could not
   * be read yet (Safari before Full Disk Access is granted).
   */
  cookieCount: Schema.optional(Schema.Int),
});
export type BrowserImportSourceProfile = typeof BrowserImportSourceProfile.Type;

export const BrowserImportSource = Schema.Struct({
  id: BrowserImportSourceId,
  name: TrimmedNonEmptyString,
  profiles: Schema.Array(BrowserImportSourceProfile),
  unavailable: Schema.optional(BrowserImportUnavailableReason),
});
export type BrowserImportSource = typeof BrowserImportSource.Type;

export const BrowserImportInput = Schema.Struct({
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
});
export type BrowserImportInput = typeof BrowserImportInput.Type;

/** IPC payload: the import input plus the environment the partition belongs to. */
export const DesktopPreviewImportCookiesInputSchema = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
});

export const BrowserImportResult = Schema.Struct({
  imported: Schema.Int,
  /**
   * Surfaced rather than hidden so a mostly-failed import doesn't look like a
   * success.
   */
  skipped: Schema.Int,
  /**
   * Capped, since a broken key can skip thousands across many sites.
   */
  skippedDomains: Schema.Array(Schema.String),
});
export type BrowserImportResult = typeof BrowserImportResult.Type;

const BROWSER_IMPORT_UNAVAILABLE_COPY: Readonly<Record<BrowserImportUnavailableReason, string>> = {
  notInstalled: "Not installed on this machine.",
  needsKeychainApproval: "Needs Keychain access to read its cookies.",
  keychainItemMissing:
    "No encryption key in your Keychain — sign in to that browser once, then retry.",
  needsFullDiskAccess:
    "Give T3 Code Full Disk Access in System Settings → Privacy & Security, then retry.",
  browserRunning: "Quit the browser first so its cookie database can be read.",
  unsupportedPlatform: "Importing from this browser isn't possible on this platform.",
};

export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  ...BROWSER_IMPORT_UNAVAILABLE_COPY,
  keychainUnavailable:
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  unknownSource: "That browser is no longer available to import from.",
  unknownSourceProfile: "That browser profile no longer exists.",
  sessionUnavailable: "The target profile could not be opened.",
  profileNotSaved: "The cookies were imported, but the new profile couldn't be saved. Try again.",
  profileLimitReached:
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  readFailed: "The browser's cookie database could not be read.",
};
