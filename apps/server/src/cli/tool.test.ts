import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Tool } from "effect/ai";

import { McpToolkits } from "../mcp/toolkits/registry.ts";
import { applyCallerThread, findMcpTool } from "./tool.ts";

const registryToolNames = () =>
  McpToolkits.flatMap((toolkit) =>
    Object.values(toolkit.tools).map((tool) => tool.name),
  ).toSorted();

it.effect("describes every registry tool with its MCP input schema", () =>
  Effect.gen(function* () {
    for (const toolkit of McpToolkits) {
      for (const tool of Object.values(toolkit.tools)) {
        const entry = yield* findMcpTool(tool.name);
        expect(entry.inputSchema).toEqual(Tool.getJsonSchema(tool));
      }
    }
    expect(registryToolNames()).toContain("t3_thread_organize");
  }),
);

it.effect("rejects a tool that is not in the registry", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(findMcpTool("not_a_tool"));
    expect(error.message).toContain("t3 tool list");
  }),
);

it.effect("requires a thread for thread-bound tools without a thread credential", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const error = yield* Effect.flip(
      applyCallerThread({
        tool,
        arguments: { action: "pin" },
        thread: Option.none(),
        hasThreadCredential: false,
      }),
    );
    expect(error.message).toContain("--thread");
  }),
);

it.effect("fills the thread from --thread and keeps an explicit threadId", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const filled = yield* applyCallerThread({
      tool,
      arguments: { action: "pin" },
      thread: Option.some("thread-a"),
      hasThreadCredential: false,
    });
    expect(filled.threadId).toBe("thread-a");
    const explicit = yield* applyCallerThread({
      tool,
      arguments: { action: "pin", threadId: "thread-b" },
      thread: Option.some("thread-a"),
      hasThreadCredential: false,
    });
    expect(explicit.threadId).toBe("thread-b");
  }),
);

it.effect("lets a thread credential omit the thread", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const result = yield* applyCallerThread({
      tool,
      arguments: { action: "pin" },
      thread: Option.none(),
      hasThreadCredential: true,
    });
    expect(result.threadId).toBeUndefined();
  }),
);
