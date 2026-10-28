import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledMessageCreateInput, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledMessageService from "./ScheduledMessageService.ts";

const decodeCreate = Schema.decodeUnknownEffect(ScheduledMessageCreateInput);

const messageInput = {
  prompt: "Check the deploy in the morning.",
  sendAt: "2026-10-28T15:00:00.000Z",
  projectId: "project-schedule",
  threadId: "thread-schedule",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  creationSource: "web",
};

it.effect("sends a due message on its thread and ignores a cancelled one", () =>
  Effect.gen(function* () {
    const sent: string[] = [];
    const layer = ScheduledMessageService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(Scheduler.Scheduler)({
            register: () => Effect.void,
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input: { readonly text: string }) =>
              Effect.sync(() => {
                sent.push(input.text);
                return {
                  dispatch: {},
                } as unknown as ThreadManagementService.ThreadManagementSendResult;
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T14:00:00.000Z")),
      );
      const service = yield* ScheduledMessageService.ScheduledMessageService;
      const created = yield* service.create(yield* decodeCreate(messageInput));
      expect(created.message.status).toBe("pending");
      yield* service.dispatchDue();
      expect(sent).toEqual([]);

      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T15:00:01.000Z")),
      );
      const cancelled = yield* service.cancel({ id: created.message.id });
      expect(cancelled.cancelled).toBe(true);
      yield* service.dispatchDue();
      expect(sent).toEqual([]);

      const again = yield* service.create(
        yield* decodeCreate({ ...messageInput, sendAt: "2026-10-28T16:00:00.000Z" }),
      );
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T16:00:01.000Z")),
      );
      yield* service.dispatchDue();
      expect(sent).toEqual(["Check the deploy in the morning."]);
      expect(again.message.threadId).toBe(ThreadId.make("thread-schedule"));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
