/**
 * Fork: Web Push. Browsers subscribe on this server with its VAPID key. When a thread of this
 * server starts to wait for the user, or a running thread completes or fails, the server sends a
 * push to each subscription, so a phone shows the notification while the app is closed.
 *
 * The key is in the secret store. The subscriptions are in `<stateDir>/web-push.json`. With no
 * subscription, the service reads no thread.
 */
import {
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  WebPushError,
  type WebPushMessage,
  type WebPushSubscribeInput,
  type WebPushTestResult,
  WebPushSubscription,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { type AgentAwarenessPhase, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { generateVapidJwk, sendPush, type VapidKey, vapidKey } from "@t3tools/shared/webPush";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { shouldPublishAgentAwarenessEvent } from "../../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../../serverActivation.ts";

const KEY_SECRET_NAME = "web-push-vapid-jwk";

const SavedSubscription = Schema.Struct({
  ...WebPushSubscription.fields,
  origin: TrimmedNonEmptyString,
});
type SavedSubscription = typeof SavedSubscription.Type;
const SavedState = Schema.Struct({ subscriptions: Schema.Array(SavedSubscription) });
const decodeSavedState = Schema.decodeUnknownEffect(fromLenientJson(SavedState));
const encodeSavedState = Schema.encodeEffect(fromJsonStringPretty(SavedState));

const ACTIVE_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

/**
 * The phase change that needs a notification, or null. A thread seen for the first time since
 * the start (`previous` undefined) never notifies, so a restart does not repeat old alerts. A
 * completion or failure notifies only after an active phase: a new session reads `completed`
 * for an instant before its first turn.
 */
export function attentionTransition(
  previous: AgentAwarenessPhase | null | undefined,
  next: AgentAwarenessPhase | null,
): "waiting_for_approval" | "waiting_for_input" | "completed" | "failed" | null {
  if (previous === undefined || next === previous) return null;
  if (next === "waiting_for_approval" || next === "waiting_for_input") return next;
  if ((next === "completed" || next === "failed") && previous !== null) {
    return ACTIVE_PHASES.has(previous) ? next : null;
  }
  return null;
}

function messageFor(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
  transition: NonNullable<ReturnType<typeof attentionTransition>>,
): WebPushMessage {
  // The same titles and tag as `ThreadNotificationCoordinator`.
  const title =
    transition === "completed"
      ? "Thread completed"
      : transition === "waiting_for_approval"
        ? "Approval needed"
        : transition === "waiting_for_input"
          ? "Input needed"
          : thread.lastErrorClass === "usage_limit"
            ? "Usage limit reached"
            : "Thread failed";
  return {
    title,
    body: thread.title,
    tag: `${environmentId}:${thread.id}`,
    url: `/${environmentId}/${thread.id}`,
  };
}

/** The VAPID JWT needs a contact. The origin of the page is the closest one this server knows. */
const subjectFor = (subscription: SavedSubscription) => subscription.origin;

export class WebPush extends Context.Service<
  WebPush,
  {
    readonly publicKey: Effect.Effect<string, WebPushError>;
    readonly subscribe: (input: WebPushSubscribeInput) => Effect.Effect<void, WebPushError>;
    readonly test: (endpoint: string) => Effect.Effect<WebPushTestResult, WebPushError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/fork/webPush/WebPush") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const statePath = path.join(config.stateDir, "web-push.json");

  // A broken file must not stop the server. It starts with no subscription and logs why.
  const savedOnDisk = yield* fileSystem.readFileString(statePath).pipe(
    Effect.flatMap(decodeSavedState),
    Effect.map((saved) => saved.subscriptions),
    Effect.catch((cause) =>
      fileSystem.exists(statePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logWarning("Web Push state file is unreadable; starting empty.", {
                path: statePath,
                cause: String(cause),
              })
            : Effect.void,
        ),
        Effect.as([]),
      ),
    ),
  );
  const subscriptions = yield* Ref.make<ReadonlyArray<SavedSubscription>>(savedOnDisk);
  const writes = yield* Semaphore.make(1);

  const updateSubscriptions = (
    update: (current: ReadonlyArray<SavedSubscription>) => ReadonlyArray<SavedSubscription>,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const next = update(yield* Ref.get(subscriptions));
        yield* encodeSavedState({ subscriptions: next }).pipe(
          Effect.flatMap((contents) =>
            writeFileStringAtomically({ filePath: statePath, contents }),
          ),
          Effect.mapError(
            (cause) => new WebPushError({ operation: "save-subscriptions", detail: String(cause) }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        yield* Ref.set(subscriptions, next);
      }),
    );

  const readKeyText = Effect.gen(function* () {
    const saved = yield* secrets.get(KEY_SECRET_NAME);
    if (Option.isSome(saved)) return new TextDecoder().decode(saved.value);
    const created = yield* Effect.promise(generateVapidJwk);
    yield* secrets.create(KEY_SECRET_NAME, new TextEncoder().encode(created)).pipe(
      // Another request created the key first. Use that one.
      Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
    );
    const stored = yield* secrets.get(KEY_SECRET_NAME);
    if (Option.isNone(stored)) return yield* Effect.die("The Web Push key was not saved.");
    return new TextDecoder().decode(stored.value);
  });
  const key: Effect.Effect<VapidKey, WebPushError> = yield* Effect.cached(
    readKeyText.pipe(
      Effect.flatMap((text) => Effect.tryPromise(() => vapidKey(text))),
      Effect.flatMap((loaded) =>
        loaded === null ? Effect.fail("The Web Push key is empty.") : Effect.succeed(loaded),
      ),
      Effect.mapError(
        (cause) => new WebPushError({ operation: "read-key", detail: String(cause) }),
      ),
    ),
  );

  const removeEndpoint = (endpoint: string) =>
    updateSubscriptions((current) => current.filter((entry) => entry.endpoint !== endpoint));

  const deliver = (subscription: SavedSubscription, message: WebPushMessage) =>
    Effect.gen(function* () {
      const vapid = yield* key;
      const result = yield* Effect.tryPromise({
        try: () => sendPush(subscription, message, vapid, subjectFor(subscription)),
        catch: (cause) => new WebPushError({ operation: "send", detail: String(cause) }),
      });
      if (result === "gone") yield* removeEndpoint(subscription.endpoint);
      return result;
    });

  // The last phase of each thread since the start. Cleared while nobody subscribed.
  const phases = new Map<ThreadId, AgentAwarenessPhase | null>();

  const observeThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const targets = yield* Ref.get(subscriptions);
      if (targets.length === 0) {
        phases.clear();
        return;
      }
      const thread = yield* threads.getThreadShell(threadId);
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const phase =
        thread === null || thread.archivedAt !== null
          ? null
          : (projectThreadAwarenessV2({
              environmentId,
              project: { title: "" },
              thread,
            })?.phase ?? null);
      const transition = attentionTransition(phases.get(threadId), phase);
      phases.set(threadId, phase);
      if (transition === null || thread === null) return;
      const message = messageFor(environmentId, thread, transition);
      yield* Effect.forEach(
        targets,
        (target) =>
          deliver(target, message).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Web Push delivery failed", { detail: error.message }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Web Push could not read a thread", { threadId, cause: String(cause) }),
      ),
    );

  const worker = yield* makeDrainableWorker(observeThread);

  const start: WebPush["Service"]["start"] = Effect.fn("WebPush.start")(function* () {
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
      ),
    );
  });

  return WebPush.of({
    publicKey: key.pipe(Effect.map((loaded) => loaded.publicKey)),
    subscribe: (input) =>
      Effect.gen(function* () {
        const entry = { ...input.subscription, origin: input.origin };
        const current = (yield* Ref.get(subscriptions)).find(
          (saved) => saved.endpoint === entry.endpoint,
        );
        // Each page load subscribes again. Write only a change.
        if (
          current?.p256dh === entry.p256dh &&
          current.auth === entry.auth &&
          current.origin === entry.origin
        ) {
          return;
        }
        yield* updateSubscriptions((saved) => [
          ...saved.filter((other) => other.endpoint !== entry.endpoint),
          entry,
        ]);
      }),
    test: (endpoint) =>
      Effect.gen(function* () {
        const target = (yield* Ref.get(subscriptions)).find((entry) => entry.endpoint === endpoint);
        if (target === undefined) return { result: "unknown-subscription" as const };
        const result = yield* deliver(target, {
          title: "T3 Code",
          body: "Notifications from this server work on this device.",
          tag: "web-push-test",
          url: "/",
        });
        return { result };
      }),
    start,
  });
});

export const layer = Layer.effect(WebPush, make);

/** Starts the thread watcher. */
export const layerWorker = Layer.effectDiscard(
  WebPush.pipe(Effect.flatMap((service) => service.start())),
);
