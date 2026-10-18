import * as NodeAssert from "node:assert";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { it } from "vite-plus/test";
import { I89_BYTES, I89_SHA256, runI89OfflineFixture } from "./I89OfflineFixture.ts";

it("executes one admitted worker and recovers exact receipts after closing and reopening SQLite", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const lane = process.env.I89_LANE_DIR ?? (yield* fs.realPath(NodeOS.tmpdir()));
      const result = yield* runI89OfflineFixture(lane);
      NodeAssert.strict.equal(result.workerStarts, 1);
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(I89_BYTES));
      NodeAssert.strict.equal(Buffer.from(digest).toString("hex"), I89_SHA256);
      NodeAssert.strict.equal(
        yield* fs.readFileString(path.join(result.directory, "scratch/result.txt")),
        I89_BYTES,
      );
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ status: Schema.String })),
      )(yield* fs.readFileString(path.join(result.directory, "receipts.json")));
      NodeAssert.strict.equal(receipt.status, "PASS");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}, 60000);
