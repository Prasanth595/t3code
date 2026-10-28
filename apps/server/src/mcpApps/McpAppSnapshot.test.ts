import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { MCP_APP_MIME_TYPE } from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { temporaryResourceStorage } from "../orchestration-v2/testkit/TemporaryResourceStorage.ts";
import { snapshotMcpApp } from "./McpAppSnapshot.ts";

it.effect("temporary MCP app snapshots fail before writing HTML", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-private-mcp-" });
    const result = yield* Effect.result(
      snapshotMcpApp({
        attachmentsDir: directory,
        threadId: ThreadId.make("private-mcp"),
        server: "private",
        tool: "private",
        resourceUri: "ui://private/app.html",
        contents: [
          {
            uri: "ui://private/app.html",
            mimeType: MCP_APP_MIME_TYPE,
            text: "<p>temporary-sentinel</p>",
          },
        ],
      }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(result.failure.message, "Keep this thread");
    assert.deepEqual(yield* fs.readDirectory(directory), []);
  }).pipe(Effect.provide(Layer.merge(temporaryResourceStorage, NodeServices.layer))),
);
