import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const Writers = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const Credential = Schema.fromJsonString(
  Schema.Struct({ endpoint: Schema.String, name: Schema.String, token: Schema.String }),
);
class ManagementError extends Schema.TaggedError<ManagementError>()("ManagementError", {
  message: Schema.String,
}) {}
const decodeWriters = Schema.decodeEffect(Writers);
const encodeWriters = Schema.encodeEffect(Writers);
const encodeCredential = Schema.encodeEffect(Credential);
const source = import.meta.dirname;
const endpoint = "https://t3-task-cache.pinglabs.workers.dev/projects/t3code";

const stateDirectory = Config.String("HOME").pipe(
  Effect.map((home) => `${home}/.config/t3-task-cache`),
);
const readWriters = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* stateDirectory;
  if (!(yield* fs.exists(`${state}/writers.json`))) return {};
  return yield* decodeWriters(yield* fs.readFileString(`${state}/writers.json`));
});
const save = Effect.fn("TaskCache.save")(function* (name: string, value: string) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* stateDirectory;
  yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
  const file = `${state}/${name}.json`;
  yield* fs.writeFileString(file, value + "\n", { mode: 0o600 });
  yield* fs.chmod(file, 0o600);
});

const deploy = Effect.fn("TaskCache.deploy")(function* (writers: Record<string, string>) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.resolve(source, "..");
  const command = ChildProcess.make(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.join(root, "node_modules/alchemy/bin/alchemy.js"),
      "deploy",
      "--stage",
      "prod",
    ],
    {
      cwd: root,
      env: { DEVELOPER_KEYS: yield* encodeWriters(writers) },
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = yield* spawner.exitCode(command);
  if (code !== 0)
    return yield* Effect.fail(
      new ManagementError({ message: `Alchemy deploy failed (exit ${code}).` }),
    );
});

const name = Argument.String("name").pipe(Argument.withDescription("Lowercase writer name"));
const updateWriter = Effect.fn("TaskCache.updateWriter")(function* (name: string, revoke: boolean) {
  if (!/^[a-z0-9-]{1,64}$/.test(name))
    return yield* Effect.fail(new ManagementError({ message: "Invalid writer name." }));
  const writers = { ...(yield* readWriters) };
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
  yield* deploy(writers);
  yield* save("writers", yield* encodeWriters(writers));
  if (!revoke) yield* save(name, yield* encodeCredential({ endpoint, name, token }));
  const state = yield* stateDirectory;
  yield* Console.log(
    revoke ? `Revoked ${name}.` : `Private credential written to ${state}/${name}.json.`,
  );
});

const command = Command.make("task-cache").pipe(
  Command.withSubcommands([
    Command.make("deploy", {}, () => readWriters.pipe(Effect.flatMap(deploy))),
    Command.make("add-writer", { name }, ({ name }) => updateWriter(name, false)),
    Command.make("revoke-writer", { name }, ({ name }) => updateWriter(name, true)),
  ]),
);

Command.run(command, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
