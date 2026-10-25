import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Writers = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeWriters = Schema.decodeEffect(Writers);
export const encodeWriters = Schema.encodeEffect(Writers);

export const stateDirectory = Config.String("HOME").pipe(
  Effect.map((home) => `${home}/.config/t3-task-cache`),
);

export const readWriters = Effect.fn("TaskCache.readWriters")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* stateDirectory;
  return yield* decodeWriters(yield* fs.readFileString(`${state}/writers.json`));
});

// An absent registry must fail deployment rather than revoke every existing writer.
export const WriterSecrets = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const configured = yield* Config.Redacted("DEVELOPER_KEYS").pipe(Config.option);
    if (Option.isSome(configured)) return ConfigProvider.fromUnknown({});
    return ConfigProvider.fromUnknown({
      DEVELOPER_KEYS: yield* encodeWriters(yield* readWriters()),
    });
  }),
);
