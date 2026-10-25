import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const Writers = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeWriters = Schema.decodeEffect(Writers);
const encodeWriters = Schema.encodeEffect(Writers);

const stateDirectory = Config.String("HOME").pipe(
  Effect.map((home) => `${home}/.config/t3-task-cache`),
);

const Credential = Schema.fromJsonString(
  Schema.Struct({ endpoint: Schema.String, name: Schema.String, token: Schema.String }),
);
class ManagementError extends Schema.TaggedError<ManagementError>()("ManagementError", {
  message: Schema.String,
}) {}
const encodeCredential = Schema.encodeEffect(Credential);
const endpoint = "https://t3-task-cache.pinglabs.workers.dev/projects/t3code";

export class WriterRegistry extends Context.Service<
  WriterRegistry,
  {
    readonly read: () => Effect.Effect<
      Record<string, string>,
      PlatformError.PlatformError | Schema.SchemaError
    >;
    readonly update: (
      name: string,
      revoke: boolean,
    ) => Effect.Effect<
      string | undefined,
      PlatformError.PlatformError | Schema.SchemaError | ManagementError
    >;
  }
>()("@t3tools/task-cache/WriterRegistry") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const state = yield* stateDirectory;
  const readWriters = Effect.fn("TaskCache.readWriters")(function* () {
    return yield* decodeWriters(yield* fs.readFileString(`${state}/writers.json`));
  });

  const save = Effect.fn("TaskCache.save")(function* (name: string, value: string) {
    yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
    const file = `${state}/${name}.json`;
    yield* fs.writeFileString(file, value + "\n", { mode: 0o600 });
    yield* fs.chmod(file, 0o600);
  });

  const updateWriter = Effect.fn("TaskCache.updateWriter")(function* (
    name: string,
    revoke: boolean,
  ) {
    if (!/^(?!writers$|credentials$)[a-z0-9-]{1,64}$/.test(name))
      return yield* new ManagementError({ message: "Invalid writer name." });
    const exists = yield* fs.exists(`${state}/writers.json`);
    const writers = { ...(exists || revoke ? yield* readWriters() : {}) };
    const token = hex(yield* crypto.randomBytes(32));
    if (revoke) delete writers[name];
    else {
      writers[name] = hex(yield* crypto.digest("SHA-256", new TextEncoder().encode(token)));
    }
    yield* save("writers", yield* encodeWriters(writers));
    if (!revoke) yield* save(name, yield* encodeCredential({ endpoint, name, token }));
    return revoke ? undefined : `${state}/${name}.json`;
  });
  return WriterRegistry.of({ read: readWriters, update: updateWriter });
});

export const layer = Layer.effect(WriterRegistry, make);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
