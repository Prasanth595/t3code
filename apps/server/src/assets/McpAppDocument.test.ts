import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as McpAppDocument from "./McpAppDocument.ts";

it.effect("preserves filesystem failures as typed MCP document read errors", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-document-" });
    const missingPath = path.join(directory, "missing.html");
    const documents = yield* McpAppDocument.McpAppDocument;
    const error = yield* documents.read(missingPath).pipe(Effect.flip);
    expect(error).toBeInstanceOf(McpAppDocument.McpAppDocumentReadError);
    expect(error.path).toBe(missingPath);
    expect(error.cause).toMatchObject({ _tag: "PlatformError", reason: { _tag: "NotFound" } });
  }).pipe(Effect.provide(McpAppDocument.layer), Effect.provide(NodeServices.layer)),
);
