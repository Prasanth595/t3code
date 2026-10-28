import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as TemporaryThreadStorage from "../orchestration-v2/TemporaryThreadStorage.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const targetId = ThreadId.make("private-target");
const siblingId = ThreadId.make("private-sibling");
const savedId = ThreadId.make("saved-caller");

it.effect.each(
  [
    ...[savedId, undefined, siblingId, targetId].map((callerId) => ({
      callerId,
      temporaryTarget: true,
    })),
    ...[savedId, undefined].map((callerId) => ({ callerId, temporaryTarget: false })),
  ].flatMap((testCase) => [false, true].map((viaTool) => ({ ...testCase, viaTool }))),
)(
  "metadata checks reverse family access before target access %#",
  ({ callerId, viaTool, temporaryTarget }) =>
    Effect.gen(function* () {
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("test"),
        requestNamespace: "test",
        thread:
          callerId === undefined
            ? undefined
            : {
                threadId: callerId,
                providerSessionId: `provider:${callerId}`,
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
        client:
          callerId === undefined
            ? { sessionId: "external", label: "test", access: "full-access" }
            : undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      };
      let targetReads = 0;
      let dispatches = 0;
      const shell = { ...liveThreadShell(targetId), title: "private-title-sentinel" };
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.sync(() => {
            if (id === targetId) targetReads++;
            return id === targetId ? shell : liveThreadShell(id);
          }),
        getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
        dispatch: () =>
          Effect.sync(() => {
            dispatches++;
            return { sequence: 1, storedEvents: [] };
          }),
      });
      const storage = Layer.mock(TemporaryThreadStorage.TemporaryThreadStorage)({
        isTemporary: (id) =>
          Effect.succeed(temporaryTarget && (id === targetId || id === siblingId)),
        isDiscarded: () => Effect.succeed(false),
        family: () => Effect.succeed([targetId, siblingId]),
      });
      const dependencies = Layer.mergeAll(
        threads,
        storage,
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size).fill(7),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      );
      const services = ThreadMetadataMcpService.layer.pipe(Layer.provideMerge(dependencies));
      const input = {
        threadId: targetId,
        action: "rename" as const,
        title: "Renamed thread",
        clientRequestId: "test",
      };
      const update = viaTool
        ? Effect.gen(function* () {
            const toolkit = yield* OrchestratorToolkit.pipe(
              Effect.provide(McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer)),
            );
            const result = yield* toolkit
              .handle("t3_thread_update", input)
              .pipe(Stream.unwrap, Stream.runCollect);
            return result.at(-1)!.result;
          }).pipe(Effect.result, Effect.map(JSON.stringify))
        : Effect.flatMap(ThreadMetadataMcpService.ThreadMetadataMcpService, (service) =>
            service.update(scope, input),
          ).pipe(Effect.result, Effect.map(JSON.stringify));
      const result = yield* update.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(services),
      );
      if (temporaryTarget && (callerId === savedId || callerId === undefined)) {
        expect(JSON.stringify(result)).not.toContain("private-title-sentinel");
        expect(targetReads).toBe(0);
        expect(dispatches).toBe(0);
        expect(JSON.stringify(result)).toContain("capability_denied");
      } else {
        expect(JSON.stringify(result)).toContain("private-title-sentinel");
        expect(dispatches).toBe(1);
      }
    }),
);
