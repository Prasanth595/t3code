import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";

import * as WriterRegistry from "../src/WriterRegistry.ts";

const name = Argument.String("name").pipe(Argument.withDescription("Lowercase writer name"));
const updateWriter = Effect.fn("TaskCache.manageWriter")(function* (name: string, revoke: boolean) {
  const registry = yield* WriterRegistry.WriterRegistry;
  const file = yield* registry.update(name, revoke);
  yield* Console.log(
    file === undefined
      ? `Removed ${name} from the local writer registry.`
      : `Private credential written to ${file}.`,
  );
  yield* Console.log(
    "Run alchemy deploy --stage prod from infra/task-cache to apply the writer changes.",
  );
});

const command = Command.make("task-cache").pipe(
  Command.withSubcommands([
    Command.make("add-writer", { name }, ({ name }) => updateWriter(name, false)),
    Command.make("revoke-writer", { name }, ({ name }) => updateWriter(name, true)),
  ]),
);

Command.run(command, { version: "1.0.0" }).pipe(
  Effect.provide(WriterRegistry.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain,
);
