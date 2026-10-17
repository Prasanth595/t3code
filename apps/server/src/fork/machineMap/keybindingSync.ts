/**
 * Fork: keybinding sync through the machine map settings (docs/fork.md "Machine map").
 *
 * The server setting `keybindings` is no settings service field. It is the rule list of
 * `keybindings.json`, which the map reports and applies only while `keybindingSync` is on. The
 * keybindings service watches that file, so a written value reloads like an edit by hand.
 *
 * The value keeps a rule with a command that this build does not know: the keybindings loader
 * skips that rule, and it works after an update. A written value is the decoded value, so it
 * reads back equal and is no local change (MM-404).
 */
import { KEYBINDINGS_SETTING_KEY, MAX_KEYBINDINGS_COUNT } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const SYNC_SETTING_KEY = "keybindingSync";
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

/**
 * The reported server settings with the rules of the file as `keybindings`, while the sync is
 * on. A file that is not a JSON array reports no value, so a broken edit is no local change.
 * Entries that are not rules stay out, like the keybindings loader skips them.
 */
export const withSyncedKeybindings = (
  fs: FileSystem.FileSystem,
  keybindingsPath: string,
  reported: Readonly<Record<string, unknown>>,
): Effect.Effect<Readonly<Record<string, unknown>>> =>
  Effect.gen(function* () {
    if (!syncOn(reported)) return reported;
    // The keybindings service writes the defaults at start. Before that, no file is no rules.
    if (!(yield* fs.exists(keybindingsPath))) return { ...reported, [KEYBINDINGS_SETTING_KEY]: [] };
    const entries = decodeFileEntries(yield* fs.readFileString(keybindingsPath));
    if (entries._tag === "Failure") return reported;
    const rules = entries.value.flatMap((entry) => {
      const rule = decodeRule(entry);
      return rule._tag === "Success" ? [rule.value] : [];
    });
    return { ...reported, [KEYBINDINGS_SETTING_KEY]: rules };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Machine map could not read the keybindings file.", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(reported)),
    ),
  );

/**
 * Writes a changed `keybindings` value of a desired state into the file. `current` is the
 * reported value before this desired state. A `keybindingSync` value in the same desired state
 * decides, because this runs before the settings patch: the settings change that turns the sync
 * on must find the new file, or it reports the old rules as a local change.
 */
export const applyKeybindingSettings = Effect.fn(function* (input: {
  readonly keybindingsPath: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
}) {
  if (!Object.hasOwn(input.values, KEYBINDINGS_SETTING_KEY)) return;
  const desiredSync = input.values[SYNC_SETTING_KEY];
  const on = typeof desiredSync === "boolean" ? desiredSync : syncOn(input.current);
  if (!on) {
    return yield* Effect.logWarning("Machine map skipped keybindings: keybindingSync is off.");
  }
  const value = input.values[KEYBINDINGS_SETTING_KEY];
  if (stableStringify(input.current[KEYBINDINGS_SETTING_KEY]) === stableStringify(value)) return;
  const decoded = decodeSyncedKeybindings(value);
  if (decoded._tag === "Failure") {
    return yield* Effect.logWarning("Machine map skipped keybindings: it is not a rule list.", {
      problem: Cause.pretty(decoded.cause),
    });
  }
  // Limit: a keybinding saved here while this write runs can be lost, because the keybindings
  // service holds its own lock. Revisit if a lost local save shows up in practice.
  yield* encodeKeybindingsFile(decoded.value).pipe(
    Effect.flatMap((encoded) =>
      writeFileStringAtomically({ filePath: input.keybindingsPath, contents: `${encoded}\n` }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Machine map could not write the keybindings file.", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
});
