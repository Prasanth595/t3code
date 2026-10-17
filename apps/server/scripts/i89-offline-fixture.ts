import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runI89OfflineFixture } from "../src/orchestration-v2/testkit/I89OfflineFixture.ts";

await Effect.runPromise(
  Effect.gen(function* () {
    const lane = process.argv[2];
    if (!lane || process.argv.length !== 3)
      return yield* Effect.die(
        new Error(
          "Usage: node apps/server/scripts/i89-offline-fixture.ts <existing-lane-directory>",
        ),
      );
    const receipt = yield* runI89OfflineFixture(lane);
    yield* Console.log(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        status: receipt.status,
        directory: receipt.directory,
        workerStarts: receipt.workerStarts,
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
