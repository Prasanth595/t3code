import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readNativeHistory } from "./NativeSessionHistory.ts";

it.effect("reads every native turn and item page twice without any native mutation", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const read = (method: string, params?: unknown) =>
      Effect.sync(() => {
        calls.push(method);
        const cursor = (params as { cursor?: string }).cursor;
        if (method === "thread/read")
          return {
            thread: {
              id: "native",
              cwd: "/work",
              cliVersion: "0.164.0",
              historyMode: "paginated",
              status: { type: "idle" },
              turns: [],
            },
          };
        if (method === "thread/goal/get") return { goal: null };
        if (method === "thread/turns/list")
          return { data: [{ id: "turn-one", status: "completed", items: [] }], nextCursor: null };
        if (method === "thread/items/list")
          return cursor
            ? {
                data: [
                  {
                    turnId: "turn-one",
                    item: { id: "item-two", type: "agentMessage", text: "external answer" },
                  },
                ],
                nextCursor: null,
              }
            : {
                data: [
                  {
                    turnId: "turn-one",
                    item: {
                      id: "item-one",
                      type: "userMessage",
                      content: [{ type: "text", text: "original native prompt" }],
                    },
                  },
                ],
                nextCursor: "page-two",
              };
        throw new Error(`Unexpected mutation ${method}`);
      });
    const history = yield* readNativeHistory(read, {
      nativeId: "native",
      cwd: "/work",
      protocolVersion: "0.164.0",
    });
    expect(history.complete).toBe(true);
    expect(history.turns[0]!.items.map((item) => item.id)).toEqual(["item-one", "item-two"]);
    expect(history.blockers).toEqual([]);
    expect(calls.filter((value) => value === "thread/items/list")).toHaveLength(4);
  }),
);
it.effect("does not call a mutable item stable merely because its head IDs match", () =>
  Effect.gen(function* () {
    let reads = 0;
    const history = yield* readNativeHistory(
      (method) =>
        Effect.sync(() => {
          if (method === "thread/goal/get") return { goal: null };
          return {
            thread: {
              id: "native",
              cwd: "/work",
              cliVersion: "0.164.0",
              historyMode: "legacy",
              status: { type: "idle" },
              turns: [
                {
                  id: "turn-one",
                  status: "completed",
                  items: [{ id: "same-item", type: "agentMessage", text: `revision-${++reads}` }],
                },
              ],
            },
          };
        }),
      { nativeId: "native", cwd: "/work", protocolVersion: "0.164.0" },
    );
    expect(history.complete).toBe(false);
    expect(history.blockers.map((value) => value.code)).toContain("history-changing");
  }),
);
it.effect("retains unknown native item identity and blocks unknown background work", () =>
  Effect.gen(function* () {
    const history = yield* readNativeHistory(
      (method) =>
        Effect.succeed(
          method === "thread/goal/get"
            ? { goal: { status: "paused" } }
            : {
                thread: {
                  id: "native",
                  cwd: "/work",
                  cliVersion: "0.164.0",
                  historyMode: "legacy",
                  status: { type: "idle" },
                  turns: [
                    {
                      id: "turn-one",
                      status: "completed",
                      items: [
                        { id: "future-item", type: "futureBackgroundJob", payload: "retained" },
                      ],
                    },
                  ],
                },
              },
        ),
      { nativeId: "native", cwd: "/work", protocolVersion: "0.164.0" },
    );
    expect(history.turns[0]!.items[0]).toMatchObject({
      id: "future-item",
      type: "futureBackgroundJob",
      payload: { payload: "retained" },
    });
    expect(history.blockers.map((value) => value.code)).toEqual(
      expect.arrayContaining(["unsupported-native-item", "native-goal"]),
    );
  }),
);

it.effect("preserves the historical creation version while the verified runtime is 0.164", () =>
  Effect.gen(function* () {
    const history = yield* readNativeHistory(
      (method) =>
        Effect.succeed(
          method === "thread/goal/get"
            ? { goal: null }
            : {
                thread: {
                  id: "native",
                  cwd: "/work",
                  cliVersion: "0.163.0",
                  historyMode: "legacy",
                  status: { type: "idle" },
                  turns: [],
                },
              },
        ),
      { nativeId: "native", cwd: "/work", protocolVersion: "0.164.0" },
    );
    expect(history.complete).toBe(true);
    expect(history.createdWithCliVersion).toBe("0.163.0");
    expect(history.blockers).toEqual([]);
  }),
);
