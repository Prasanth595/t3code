import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MissionId,
  ProjectId,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { HttpServer } from "effect/http";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcpService from "./MissionMcpService.ts";
import * as MissionMcpPolicy from "./MissionMcpPolicy.ts";

const teamId = TeamId.make("explicit-nofun-team");
const environmentId = EnvironmentId.make("policy-env");
const projectId = ProjectId.make("policy-project");
const bootstrapThreadId = ThreadId.make("policy-bootstrap-root");

const config = () => ({
  company: "nofun",
  companyVerified: true,
  bindingVerified: true,
  policyRef: "server-policy:explicit-owner-binding",
  teamId,
  environmentId,
  allowedProjectIds: [projectId],
  bootstrapControllerThreadIds: [bootstrapThreadId],
});

const decodeStrictPolicy = Schema.decodeUnknownSync(
  MissionMcpAuthority.TrustedNoFunMissionPolicy,
  { onExcessProperty: "error" },
);

const isStrictPolicy = (snapshot: unknown): boolean => {
  try {
    decodeStrictPolicy(snapshot);
    return true;
  } catch {
    return false;
  }
};

const revisionOf = (snapshot: unknown): string =>
  (snapshot as { readonly revision: string }).revision;

it.effect("starts disabled with a bounded snapshot the strict policy schema rejects", () =>
  Effect.gen(function* () {
    const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    const current = controller.policy.current();
    assert.strictEqual((current as { readonly enabled: unknown }).enabled, false);
    assert.strictEqual(typeof revisionOf(current), "string");
    assert.isTrue(revisionOf(current).length > 0);
    assert.isFalse(isStrictPolicy(current));
    assert.strictEqual(stableStringify((yield* controller.policy.read)), stableStringify(current));
    assert.isTrue(Object.isFrozen(current));
    assert.isTrue(Object.isFrozen((yield* controller.policy.read)));
  }),
);

it("rejects missing, unverified, and foreign company configuration without enabling", () => {
  const candidates = [
    { ...config(), companyVerified: false },
    { ...config(), bindingVerified: false },
    { ...config(), company: "other" },
    { ...config(), policyRef: "" },
    { ...config(), policyRef: "   " },
    { ...config(), teamId: undefined },
    { ...config(), environmentId: undefined },
    "not-an-object",
    null,
  ];
  const revisions = new Set<string>();
  for (const candidate of candidates) {
    const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    const before = revisionOf(controller.policy.current());
    revisions.add(before);
    try {
      controller.publish(candidate);
      assert.fail("publish must reject the candidate");
    } catch (error) {
      assert.instanceOf(error, MissionMcpPolicy.MissionMcpPolicyError);
      assert.strictEqual(
        (error as Error).message,
        "The trusted mission policy update was rejected.",
      );
      assert.isFalse((error as Error).message.includes("explicit-owner-binding"));
    }
    const current = controller.policy.current();
    assert.strictEqual((current as { readonly enabled: unknown }).enabled, false);
    assert.isFalse(isStrictPolicy(current));
    revisions.add(revisionOf(current));
  }
  // Every invalid configuration consumed its own fresh revision, even the
  // non-object candidates: no revision is ever reused.
  assert.strictEqual(revisions.size, candidates.length * 2);
});

it("rejects a supplied revision and any excess keys without enabling", () => {
  for (const candidate of [
    { ...config(), revision: "caller-supplied-revision" },
    { ...config(), enabled: true },
    { ...config(), extraKey: "extra" },
  ]) {
    const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    const before = revisionOf(controller.policy.current());
    assert.throws(() => controller.publish(candidate), MissionMcpPolicy.MissionMcpPolicyError);
    const current = controller.policy.current();
    assert.strictEqual((current as { readonly enabled: unknown }).enabled, false);
    assert.notStrictEqual(revisionOf(current), before);
    assert.isFalse(isStrictPolicy(current));
  }
});

it.effect("enables on explicit publish with identical detached frozen read/current", () =>
  Effect.gen(function* () {
    const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    const published = controller.publish(config());
    assert.isTrue(Object.isFrozen(published));
    const current = controller.policy.current();
    const read = (yield* controller.policy.read);
    const decoded = decodeStrictPolicy(current);
    assert.strictEqual(decoded.enabled, true);
    assert.strictEqual(decoded.company, "nofun");
    assert.strictEqual(decoded.policyRef, "server-policy:explicit-owner-binding");
    assert.deepStrictEqual(decoded.allowedProjectIds, [projectId]);
    assert.deepStrictEqual(decoded.bootstrapControllerThreadIds, [bootstrapThreadId]);
    assert.strictEqual(stableStringify(read), stableStringify(current));
    assert.strictEqual(stableStringify(published), stableStringify(current));
    assert.notStrictEqual(current, read);
    assert.notStrictEqual(current, published);
    assert.isTrue(Object.isFrozen(current));
    assert.isTrue(Object.isFrozen((current as { readonly allowedProjectIds: unknown }).allowedProjectIds));
    assert.isTrue(
      Object.isFrozen(
        (current as { readonly bootstrapControllerThreadIds: unknown }).bootstrapControllerThreadIds,
      ),
    );
  }),
);

it("input mutation after publish cannot edit the published policy", () => {
  const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
  const input = config();
  controller.publish(input);
  input.allowedProjectIds.push(ProjectId.make("policy-project-injected"));
  input.bootstrapControllerThreadIds.length = 0;
  (input as { policyRef: string }).policyRef = "mutated-after-publish";
  const decoded = decodeStrictPolicy(controller.policy.current());
  assert.deepStrictEqual(decoded.allowedProjectIds, [projectId]);
  assert.deepStrictEqual(decoded.bootstrapControllerThreadIds, [bootstrapThreadId]);
  assert.strictEqual(decoded.policyRef, "server-policy:explicit-owner-binding");
});

it.effect("caller mutation of current/read results cannot edit the stored policy", () =>
  Effect.gen(function* () {
    const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    controller.publish(config());
    const current = controller.policy.current() as {
      readonly allowedProjectIds: Array<unknown>;
    };
    assert.throws(() => {
      current.allowedProjectIds.push(ProjectId.make("policy-project-injected"));
    });
    const read = (yield* controller.policy.read) as { readonly allowedProjectIds: Array<unknown> };
    assert.throws(() => {
      read.allowedProjectIds.push(ProjectId.make("policy-project-injected"));
    });
    const decoded = decodeStrictPolicy(controller.policy.current());
    assert.deepStrictEqual(decoded.allowedProjectIds, [projectId]);
  }),
);

it("mints a never-reused revision on every operation", () => {
  const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
  const revisions = [revisionOf(controller.policy.current())];
  revisions.push(revisionOf(controller.publish(config())));
  revisions.push(revisionOf(controller.publish(config())));
  controller.disable();
  revisions.push(revisionOf(controller.policy.current()));
  revisions.push(revisionOf(controller.publish(config())));
  controller.revoke();
  revisions.push(revisionOf(controller.policy.current()));
  assert.throws(() => controller.publish({ ...config(), company: "other" }));
  revisions.push(revisionOf(controller.policy.current()));
  assert.strictEqual(new Set(revisions).size, revisions.length);
  assert.strictEqual(revisions.length, 7);
});

it.effect("invalid update revokes a previously enabled policy with no stale fallback", () =>
  Effect.gen(function* () {
    const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    controller.publish(config());
    const enabledSnapshot = controller.policy.current();
    assert.isTrue(isStrictPolicy(enabledSnapshot));
    assert.throws(() => controller.publish({ ...config(), companyVerified: false }));
    const current = controller.policy.current();
    assert.strictEqual((current as { readonly enabled: unknown }).enabled, false);
    assert.isFalse(isStrictPolicy(current));
    assert.notStrictEqual(revisionOf(current), revisionOf(enabledSnapshot));
    assert.strictEqual(stableStringify((yield* controller.policy.read)), stableStringify(current));
    // The previously captured snapshot is unchanged and unusable as a fallback:
    // its revision is retired and the live service no longer serves it.
    assert.isTrue(isStrictPolicy(enabledSnapshot));
    assert.notStrictEqual(stableStringify(enabledSnapshot), stableStringify(current));
  }),
);

it("membership change leaves the previously captured snapshot unchanged", () => {
  const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
  controller.publish(config());
  const before = controller.policy.current();
  const beforeIdentity = stableStringify(before);
  const otherProject = ProjectId.make("policy-project-other");
  controller.publish({
    ...config(),
    teamId: TeamId.make("explicit-nofun-team-rotated"),
    allowedProjectIds: [otherProject],
    bootstrapControllerThreadIds: [],
  });
  const after = controller.policy.current();
  assert.notStrictEqual(stableStringify(after), beforeIdentity);
  assert.strictEqual(stableStringify(before), beforeIdentity);
  assert.notStrictEqual(revisionOf(after), revisionOf(before));
  const decoded = decodeStrictPolicy(after);
  assert.deepStrictEqual(decoded.allowedProjectIds, [otherProject]);
  assert.deepStrictEqual(decoded.bootstrapControllerThreadIds, []);
});

it("enforces bounded allow-lists with no enabled fallback", () => {
  const many = Array.from({ length: 65 }, (_, index) => ProjectId.make(`policy-project-${index}`));
  const dupes = [projectId, projectId];
  for (const candidate of [
    { ...config(), allowedProjectIds: [] },
    { ...config(), allowedProjectIds: many },
    { ...config(), allowedProjectIds: dupes },
    { ...config(), bootstrapControllerThreadIds: dupes },
    {
      ...config(),
      bootstrapControllerThreadIds: Array.from(
        { length: 65 },
        (_, index) => ThreadId.make(`policy-bootstrap-${index}`),
      ),
    },
  ]) {
    const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
    assert.throws(() => controller.publish(candidate), MissionMcpPolicy.MissionMcpPolicyError);
    assert.strictEqual(
      (controller.policy.current() as { readonly enabled: unknown }).enabled,
      false,
    );
  }
  const bounded = new MissionMcpPolicy.MissionMcpPolicyPublisher();
  bounded.publish({
    ...config(),
    allowedProjectIds: Array.from({ length: 64 }, (_, index) =>
      ProjectId.make(`policy-project-${index}`),
    ),
    bootstrapControllerThreadIds: [],
  });
  const decoded = decodeStrictPolicy(bounded.policy.current());
  assert.strictEqual(decoded.allowedProjectIds.length, 64);
  assert.deepStrictEqual(decoded.bootstrapControllerThreadIds, []);
});

// Real resolver composition: the actual published policy service drives the
// real MissionMcpAuthority resolver over an in-memory stack.

const instanceId = ProviderInstanceId.make("configured-codex-account");
const probeMissionId = MissionId.make("policy-probe-missing");
const now = "2026-10-14T00:00:00.000Z";

const memory = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("Unused descriptor"),
});
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43127),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const setup = (controller: MissionMcpPolicy.MissionMcpPolicyPublisher) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const actualProjections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("policy-project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Policy fixture",
        workspaceRoot: "/tmp/policy-fixture",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    const date = DateTime.makeUnsafe(now);
    yield* actualProjections.apply({
      id: EventId.make("policy-thread-created"),
      type: "thread.created",
      threadId: bootstrapThreadId,
      occurredAt: date,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: bootstrapThreadId,
        projectId,
        title: "Policy bootstrap root",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "configured-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: bootstrapThreadId,
        },
        forkedFrom: null,
        createdAt: date,
        updatedAt: date,
        archivedAt: null,
        settledAt: null,
        settledOverride: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => 1_000, livenessWindowMs: 100 })
      .pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(HttpServer.HttpServer, httpServer),
        Effect.provide(NodeServices.layer),
      );
    const credential = yield* registry.issue({
      threadId: bootstrapThreadId,
      providerInstanceId: instanceId,
    });
    const scope = yield* registry.resolve(
      credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    if (scope === undefined) return yield* Effect.die("Test credential did not resolve.");
    const authority = yield* MissionMcpService.MissionMcpAuthorityPort.pipe(
      Effect.provide(MissionMcpAuthority.layer),
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, actualProjections),
      Effect.provideService(MissionMcpAuthority.MissionMcpTrustedPolicy, controller.policy),
    );
    return { authority, scope };
  });

it.effect(
  "published policy authorizes the real resolver and disablement denies it",
  () =>
    Effect.gen(function* () {
      const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
      const h = yield* setup(controller);
      const resolve = () =>
        h.authority.resolve({ scope: h.scope, operation: "read", missionId: probeMissionId });
      assert.strictEqual((yield* Effect.flip(resolve())).code, "authority_unavailable");
      const enabledRevision = revisionOf(controller.publish(config()));
      const facts = yield* resolve();
      assert.strictEqual(facts.company, "nofun");
      assert.strictEqual(facts.teamId, "explicit-nofun-team");
      assert.strictEqual(facts.environmentId, environmentId);
      assert.strictEqual(facts.controllerThreadId, bootstrapThreadId);
      controller.disable();
      assert.strictEqual((yield* Effect.flip(resolve())).code, "authority_unavailable");
      const reenabledRevision = revisionOf(controller.publish(config()));
      assert.notStrictEqual(reenabledRevision, enabledRevision);
      assert.strictEqual((yield* resolve()).controllerThreadId, bootstrapThreadId);
    }).pipe(Effect.provide(memory)),
);
