import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";

import { encodeWriters, readWriters, stateDirectory } from "./writers.ts";
const Credential = Schema.fromJsonString(
  Schema.Struct({ endpoint: Schema.String, name: Schema.String, token: Schema.String }),
);
class ManagementError extends Schema.TaggedError<ManagementError>()("ManagementError", {
  message: Schema.String,
}) {}
const encodeCredential = Schema.encodeEffect(Credential);
const endpoint = "https://t3-task-cache.pinglabs.workers.dev/projects/t3code";

const save = Effect.fn("TaskCache.save")(function* (name: string, value: string) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* stateDirectory;
  yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
  const file = `${state}/${name}.json`;
  yield* fs.writeFileString(file, value + "\n", { mode: 0o600 });
  yield* fs.chmod(file, 0o600);
});

const name = Argument.String("name").pipe(Argument.withDescription("Lowercase writer name"));
const updateWriter = Effect.fn("TaskCache.updateWriter")(function* (name: string, revoke: boolean) {
  if (!/^[a-z0-9-]{1,64}$/.test(name))
    return yield* new ManagementError({ message: "Invalid writer name." });
  const fs = yield* FileSystem.FileSystem;
  const state = yield* stateDirectory;
  const exists = yield* fs.exists(`${state}/writers.json`);
  const writers = { ...(exists || revoke ? yield* readWriters() : {}) };
  const token = yield* Effect.sync(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
  if (revoke) delete writers[name];
  else {
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    writers[name] = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  yield* save("writers", yield* encodeWriters(writers));
  if (!revoke) yield* save(name, yield* encodeCredential({ endpoint, name, token }));
  yield* Console.log(
    revoke
      ? `Removed ${name} from the local writer registry.`
      : `Private credential written to ${state}/${name}.json.`,
  );
  yield* Console.log(
    "Run bun alchemy deploy --stage prod from infra/task-cache to apply the writer changes.",
  );
});

const command = Command.make("task-cache").pipe(
  Command.withSubcommands([
    Command.make("add-writer", { name }, ({ name }) => updateWriter(name, false)),
    Command.make("revoke-writer", { name }, ({ name }) => updateWriter(name, true)),
  ]),
);

Command.run(command, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
