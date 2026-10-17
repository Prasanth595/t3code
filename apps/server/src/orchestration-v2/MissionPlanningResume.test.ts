import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  Mission,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ProPlanningEvent } from "../../../../packages/contracts/src/missionProPlanning.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderMock from "../provider/testUtils/providerRegistryMock.ts";
import * as Facts from "./MissionPlanningFacts.ts";
import * as Planning from "./MissionPlanningStore.ts";
import type { MissionPlanningRow } from "./MissionPlanningProjection.ts";
import { MissionAuthority } from "./MissionService.ts";
import { planningWakeFor } from "./MissionPlanningWake.ts";

// Synthetic GUI observations only. This exercises real files, migrated SQL and
// production facts/store code, not a ChatGPT account, allowance or GUI result.
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hex = (char: string) => char.repeat(64);
const scope = {
  teamId: TeamId.make("nofun"),
  environmentId: EnvironmentId.make("planning-fixture"),
  controllerThreadId: ThreadId.make("delivery"),
};
const mission = Schema.decodeUnknownSync(Mission)({
  schemaVersion: 1,
  id: "mission",
  revision: 0,
  teamId: scope.teamId,
  authorityEnvironmentId: scope.environmentId,
  bindings: [
    {
      projectId: "project",
      workspaceRoot: "/tmp/synthetic",
      baseCommit: "base",
      ancestry: ["base"],
    },
  ],
  intent: {
    outcome: "Synthetic planning",
    scope: ["fixture"],
    exclusions: [],
    authorityRefs: [{ source: "user", ref: "fixture-approval" }],
    acceptanceCriteria: [{ id: "ac", text: "No duplicate submission" }],
    decisions: [],
  },
  integrationTarget: { summary: "proposed only" },
  managers: { delivery: { threadId: scope.controllerThreadId, epoch: 1 } },
  status: "active",
  tasks: [],
  updatedAt: "2026-10-17T00:00:00.000Z",
});
const actor = { managerThreadId: scope.controllerThreadId, managerEpoch: 1 };
const identity = { planningId: "plan", idempotencyKey: "idempotent-plan", actor };
const route = {
  accountRef: "synthetic-account",
  workspaceRef: "synthetic-workspace",
  chatMode: "Chat",
  proOption: "Pro",
  model: "synthetic-Pro",
};
const prepared = {
  schemaVersion: 1,
  planningId: identity.planningId,
  submissionId: "submission",
  idempotencyKey: identity.idempotencyKey,
  missionId: mission.id,
  missionRevision: 0,
  teamId: scope.teamId,
  environmentId: scope.environmentId,
  ...actor,
  stage: "prepared",
  revision: 0,
  route,
  prompt: { revision: 1, sha256: hex("a"), sourcePointers: [], attachmentHashes: [hex("b")] },
};

const lifecycle = (finish: "complete" | "cancel") =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "planning-resume-" });
      const now = yield* Clock.currentTimeMillis;
      const iso = DateTime.formatIso(DateTime.makeUnsafe(now));
      const config = Config.layerTest(root, { prefix: "state-" });
      const services = Planning.layer.pipe(
        Layer.provideMerge(Facts.layer),
        Layer.provide(Receipts.layer),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(config),
        Layer.provide(Layer.succeed(MissionAuthority, scope)),
        Layer.provide(
          Layer.mock(Environment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(scope.environmentId),
          }),
        ),
        Layer.provide(
          ProviderMock.layer([
            {
              driver: ProviderDriverKind.make("codex"),
              instanceId: ProviderInstanceId.make("operator"),
              enabled: true,
              installed: true,
              version: "fixture",
              status: "ready",
              checkedAt: iso,
              auth: { status: "authenticated" },
              models: [],
              skills: [],
              slashCommands: [],
              usageLimits: {
                checkedAt: iso,
                windows: [{ id: "weekly", kind: "weekly", label: "weekly", usedPercent: 10 }],
              },
            },
          ]),
        ),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Planning.MissionPlanningStore;
        const facts = yield* Planning.MissionPlanningFactsPort;
        const state = yield* Config.ServerConfig;
        yield* fs.makeDirectory(`${state.stateDir}/nofun`, { recursive: true, mode: 0o700 });
        const file = `${state.stateDir}/nofun/planning-observations.json`;
        yield* sql`INSERT INTO projection_missions (mission_id, team_id, authority_environment_id, revision, snapshot_json, updated_at)
        VALUES (${mission.id}, ${mission.teamId}, ${mission.authorityEnvironmentId}, 0, ${encode(mission)}, ${iso})`;
        const write = (eventType: ProPlanningEvent["type"], extra: Record<string, unknown> = {}) =>
          fs.writeFileString(
            file,
            encode([
              {
                version: 1,
                missionId: mission.id,
                teamId: mission.teamId,
                environmentId: scope.environmentId,
                missionRevision: 0,
                ...actor,
                planningId: identity.planningId,
                idempotencyKey: identity.idempotencyKey,
                eventType,
                operator: { instanceId: "operator", model: "gpt-6.1-sol" },
                observedAtMs: now,
                responseAllowance: "available",
                ...extra,
              },
            ]),
            { mode: 0o600 },
          );
        const commit = (commandId: string, event: unknown) =>
          store.commit({ commandId, missionId: mission.id, event });
        const row = Effect.map(
          sql<MissionPlanningRow>`SELECT * FROM projection_mission_planning WHERE planning_id = 'plan'`,
          (rows) => rows[0]!,
        );
        const ok = (result: Planning.MissionPlanningResult) => {
          assert(Result.isSuccess(result));
          return result.success;
        };
        if (finish === "complete") {
          yield* write("prepare", { managerEpoch: 2 });
          const wrongEpoch = yield* commit("wrong-epoch", {
            type: "prepare",
            actor,
            prepared,
          }).pipe(Effect.result);
          assert(Result.isFailure(wrongEpoch));
          assert.strictEqual(wrongEpoch.failure.category, "scope_denied");
          yield* write("prepare", { observedAtMs: now + 31000 });
          const future = yield* commit("future-observation", { type: "prepare", actor, prepared });
          assert(Result.isFailure(future));
          assert(future.failure.reasons.includes("facts_from_future"));
          const plans = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM projection_mission_planning`;
          assert.strictEqual(plans[0]?.count, 0);
        }
        yield* write("prepare");
        const reservation = ok(yield* commit("prepare", { type: "prepare", actor, prepared }));
        assert.strictEqual(reservation.recordPersisted, true);
        assert.strictEqual(reservation.submitAuthorized, false);
        assert.strictEqual((yield* row).stage, "prepared");

        yield* write("submit", {
          planningApproval: {
            approvalRef: "fixture-approval",
            planningId: "plan",
            promptSha256: hex("a"),
            scopeDigest: hex("c"),
          },
          verification: {
            receiptRef: "fixture-gui",
            verifiedAtMs: now,
            submissionId: "submission",
            promptRevision: 1,
            promptSha256: hex("a"),
            accountRef: route.accountRef,
            workspaceRef: route.workspaceRef,
            chatMode: route.chatMode,
            proOption: route.proOption,
          },
        });
        const submitted = ok(yield* commit("submit", { type: "submit", ...identity }));
        let submits = submitted.submitAuthorized ? 1 : 0;
        assert.strictEqual(submits, 1);
        const replay = ok(yield* commit("submit", { type: "submit", ...identity }));
        submits += replay.submitAuthorized ? 1 : 0;
        assert.strictEqual(submits, 1);
        const lostAck = ok(
          yield* store.restart({
            commandId: "lost-submit-ack",
            missionId: mission.id,
            planningId: "plan",
          }),
        );
        assert.strictEqual(lostAck.decision.action, "locate_existing");
        assert.strictEqual(lostAck.submitAuthorized, false);

        yield* write("await_response");
        const pending = ok(
          yield* commit("pending", {
            type: "await_response",
            ...identity,
            conversation: { conversationRef: "https://example.test/c/same", source: "located" },
            wake: { wakeKey: "same-wake", notBeforeMs: now, expiresAtMs: now + 60000 },
          }),
        );
        assert.strictEqual(pending.durableGuiLease, "released");
        const wake = planningWakeFor(mission, yield* row, now);
        assert(wake !== undefined);
        assert.strictEqual(wake.wakeKey, planningWakeFor(mission, yield* row, now + 1000)?.wakeKey);
        assert.strictEqual(planningWakeFor(mission, yield* row, now + 60000), undefined);
        const resumed = ok(
          yield* store.restart({ commandId: "resume", missionId: mission.id, planningId: "plan" }),
        );
        assert.strictEqual(
          resumed.record?.conversation?.conversationRef,
          "https://example.test/c/same",
        );
        assert.strictEqual(resumed.submitAuthorized, false);
        yield* write("retrieve", {
          completion: {
            receiptRef: "fixture-completion",
            verifiedAtMs: now,
            planningId: "plan",
            submissionId: "submission",
            conversationRef: "https://example.test/c/same",
            responseRef: "https://example.test/c/same/answer",
            completionEvidenceSha256: hex("d"),
            responseSha256: hex("e"),
            accountRef: route.accountRef,
            workspaceRef: route.workspaceRef,
            observedModel: route.model,
            observedMode: route.chatMode,
            pagesExpected: 1,
            pagesRetrieved: 1,
            requiredAttachmentHashes: [hex("b")],
            verifiedAttachmentHashes: [],
          },
        });
        const incomplete = yield* commit("incomplete", {
          type: "retrieve",
          ...identity,
          responseRef: "https://example.test/c/same/answer",
        });
        assert(Result.isFailure(incomplete));
        assert(incomplete.failure.reasons.includes("attachment_incomplete"));
        assert.strictEqual((yield* row).stage, "response_pending");

        if (finish === "complete") {
          yield* write("retrieve", {
            completion: {
              receiptRef: "fixture-completion",
              verifiedAtMs: now,
              planningId: "plan",
              submissionId: "submission",
              conversationRef: "https://example.test/c/same",
              responseRef: "https://example.test/c/same/answer",
              completionEvidenceSha256: hex("d"),
              responseSha256: hex("e"),
              accountRef: route.accountRef,
              workspaceRef: route.workspaceRef,
              observedModel: route.model,
              observedMode: route.chatMode,
              pagesExpected: 1,
              pagesRetrieved: 1,
              requiredAttachmentHashes: [hex("b")],
              verifiedAttachmentHashes: [hex("b")],
            },
          });
          const retrieved = ok(
            yield* commit("complete", {
              type: "retrieve",
              ...identity,
              responseRef: "https://example.test/c/same/answer",
            }),
          );
          assert.strictEqual(retrieved.record?.stage, "retrieved");
          assert.strictEqual(retrieved.durableGuiLease, "released");
          yield* write("reconcile", {
            planningApproval: {
              approvalRef: "fixture-approval",
              planningId: "plan",
              promptSha256: hex("a"),
              scopeDigest: hex("c"),
            },
          });
          const reconciled = ok(
            yield* commit("reconcile", {
              type: "reconcile",
              ...identity,
              reconciliation: {
                recommendationRef: "https://example.test/c/same/answer",
                currentConstraintRef: "fixture-constraint",
                constraintRevision: 0,
                adaptedRouteRef: "fixture-route",
                acceptanceDigest: createHash("sha256")
                  .update(stableStringify(mission.intent.acceptanceCriteria))
                  .digest("hex"),
                scopeDigest: hex("c"),
                proposalRevision: 1,
                reconciliationRef: "fixture-proposed-plan",
              },
            }),
          );
          assert.strictEqual(reconciled.record?.stage, "reconciled");
          assert.strictEqual(reconciled.decision.authority, "proposal_only");
          assert.strictEqual(reconciled.submitAuthorized, false);
          assert.strictEqual(submits, 1);
          assert.strictEqual(planningWakeFor(mission, yield* row, now), undefined);
          return;
        }

        // GUI/quota evidence loss must not prevent cancellation. Afterwards a late
        // wake is a no-op and no saved correlation can authorize another submit.
        yield* fs.remove(file);
        const cancelled = ok(
          yield* commit("cancel", { type: "cancel", ...identity, reason: "operator_cancel" }),
        );
        assert.strictEqual(cancelled.record?.stage, "cancelled");
        assert.strictEqual(cancelled.durableGuiLease, "released");
        assert.strictEqual(planningWakeFor(mission, yield* row, now), undefined);
        const late = ok(
          yield* store.restart({ commandId: "late", missionId: mission.id, planningId: "plan" }),
        );
        assert.strictEqual(late.decision.kind, "noop");
        assert.strictEqual(late.submitAuthorized, false);
        yield* write("wake");
        const lateWake = ok(
          yield* commit("late-wake", { type: "wake", ...identity, wakeKey: "same-wake" }),
        );
        assert.strictEqual(lateWake.decision.kind, "noop");
        assert.strictEqual(lateWake.submitAuthorized, false);
        assert.strictEqual(submits, 1);
        // Cancellation is a passive canonical observation, not a fake available pool.
        const cancellationFacts = yield* facts.readFacts({
          missionId: mission.id,
          planningId: "plan",
          idempotencyKey: identity.idempotencyKey,
          eventType: "cancel",
        });
        assert.deepStrictEqual(cancellationFacts, {
          binding: {
            missionRevision: 0,
            teamId: mission.teamId,
            environmentId: scope.environmentId,
            ...actor,
          },
          observedAtMs: now,
          usage: { operatorBudget: "unknown", responseAllowance: "unknown" },
        });
      }).pipe(Effect.provide(services));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "persists before one submit and resumes a complete proposed response without resubmitting",
  () => lifecycle("complete"),
);
it.effect("cancels a pending wait without GUI evidence and refuses late wake/restart", () =>
  lifecycle("cancel"),
);
// @effect-diagnostics nodeBuiltinImport:off -- independent acceptance digest for the SQL boundary fixture.
import { createHash } from "node:crypto";
