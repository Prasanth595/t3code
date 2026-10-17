/**
 * Fork: keybinding sync through the machine map settings (apps/machine-map/SPEC.md, MM-414).
 *
 * The server setting `keybindings` is no settings service field. It is the rule list of
 * `keybindings.json`, which the map reports and applies only while `keybindingSync` is on. The
 * keybindings service watches that file, so a written value reloads like an edit by hand.
 *
 * The value keeps a rule with a command that this build does not know: the keybindings loader
 * skips that rule, and it works after an update. A written value is the decoded value, so it
 * reads back equal and is no local change (MM-404). A write replaces the whole file, so the
 * file before it stays as `keybindings.json.bak`.
 */
import {
  KEYBINDINGS_SETTING_KEY,
  MAX_KEYBINDINGS_COUNT,
  type ServerSettings,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const SYNC_SETTING_KEY = "keybindingSync" satisfies keyof ServerSettings;
/** Larger than every key, command and `when` limit of the keybinding contracts. */
const MAX_RULE_TEXT_LENGTH = 1024;

const RuleText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_RULE_TEXT_LENGTH),
);
/** A rule by its shape only: the command list and the `when` grammar change between builds. */
const SyncedKeybindingRule = Schema.Struct({
  key: RuleText,
  command: RuleText,
  when: Schema.optionalKey(RuleText),
});
const SyncedKeybindings = Schema.Array(SyncedKeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
const decodeFileEntries = Schema.decodeUnknownExit(fromLenientJson(Schema.Array(Schema.Unknown)));
const decodeRule = Schema.decodeUnknownExit(SyncedKeybindingRule);
const decodeSyncedKeybindings = Schema.decodeUnknownExit(SyncedKeybindings);
const encodeKeybindingsFile = Schema.encodeEffect(fromJsonStringPretty(SyncedKeybindings));

const syncOn = (values: Readonly<Record<string, unknown>>) => values[SYNC_SETTING_KEY] === true;

/** Entries that are not rules stay out, like the keybindings loader skips them. */
const readKeybindingsFile = (fs: FileSystem.FileSystem, keybindingsPath: string) =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(keybindingsPath))) return { _tag: "Missing" } as const;
    const entries = decodeFileEntries(yield* fs.readFileString(keybindingsPath));
    if (entries._tag === "Failure") return { _tag: "NotAnArray" } as const;
    const rules = entries.value.flatMap((entry) => {
      const rule = decodeRule(entry);
      return rule._tag === "Success" ? [rule.value] : [];
    });
    return { _tag: "Rules", rules } as const;
  });

/**
 * The reported server settings with the rules of the file as `keybindings`, while the sync is
 * on. A file that is not a JSON array reports no value, so a broken edit is no local change.
 */
export const withSyncedKeybindings = (
  fs: FileSystem.FileSystem,
  keybindingsPath: string,
  reported: Readonly<Record<string, unknown>>,
): Effect.Effect<Readonly<Record<string, unknown>>> =>
  Effect.gen(function* () {
    if (!syncOn(reported)) return reported;
    const file = yield* readKeybindingsFile(fs, keybindingsPath);
    switch (file._tag) {
      // The keybindings service writes the defaults at start. Before that, no file is no rules.
      case "Missing":
        return { ...reported, [KEYBINDINGS_SETTING_KEY]: [] };
      case "Rules":
        return { ...reported, [KEYBINDINGS_SETTING_KEY]: file.rules };
      case "NotAnArray":
        return reported;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Machine map could not read the keybindings file.", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(reported)),
    ),
  );

/** The sync state of a desired state: its own `keybindingSync` value, or else the local one. */
const syncOnFor = (
  values: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
) => {
  const sync = values[SYNC_SETTING_KEY];
  return typeof sync === "boolean" ? sync : syncOn(current);
};

/**
 * Writes the `keybindings` value of a desired state into the file, when it differs from the
 * value that the previous desired state applied. So the saved desired state at start, and a
 * revision that changes another setting, leave the file alone: a default rule that the
 * keybindings service adds at start stays, and the machine reports it as its own value (MM-404).
 * A `keybindingSync` value in the same desired state decides, because this runs before the
 * settings patch: the settings change that turns the sync on must find the new file, or it
 * reports the old rules as a local change.
 */
export const applyKeybindingSettings = Effect.fn(function* (input: {
  readonly keybindingsPath: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** The server settings of the previous desired state; at start, the saved one itself. */
  readonly previous: Readonly<Record<string, unknown>> | null;
  readonly current: Readonly<Record<string, unknown>>;
}) {
  if (!Object.hasOwn(input.values, KEYBINDINGS_SETTING_KEY)) return;
  if (!syncOnFor(input.values, input.current)) {
    return yield* Effect.logWarning("Machine map skipped keybindings: keybindingSync is off.");
  }
  const value = input.values[KEYBINDINGS_SETTING_KEY];
  const previous = input.previous;
  if (
    previous !== null &&
    Object.hasOwn(previous, KEYBINDINGS_SETTING_KEY) &&
    syncOnFor(previous, input.current) &&
    stableStringify(previous[KEYBINDINGS_SETTING_KEY]) === stableStringify(value)
  ) {
    return;
  }
  const decoded = decodeSyncedKeybindings(value);
  if (decoded._tag === "Failure") {
    return yield* Effect.logWarning("Machine map skipped keybindings: it is not a rule list.", {
      problem: Cause.pretty(decoded.cause),
    });
  }
  const fs = yield* FileSystem.FileSystem;
  // Limit: a keybinding saved here while this write runs can be lost, because the keybindings
  // service holds its own lock. Revisit if a lost local save shows up in practice.
  yield* Effect.gen(function* () {
    const file = yield* readKeybindingsFile(fs, input.keybindingsPath);
    if (file._tag === "NotAnArray") {
      return yield* Effect.logWarning(
        "Machine map skipped keybindings: keybindings.json is not a JSON array. Fix the file.",
      );
    }
    if (file._tag === "Rules") {
      if (stableStringify(file.rules) === stableStringify(decoded.value)) return;
      yield* fs.copyFile(input.keybindingsPath, `${input.keybindingsPath}.bak`);
    }
    const encoded = yield* encodeKeybindingsFile(decoded.value);
    yield* writeFileStringAtomically({ filePath: input.keybindingsPath, contents: `${encoded}\n` });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Machine map could not write the keybindings file.", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
});
