/**
 * Fork: machine map (`apps/machine-map/SPEC.md`). The portal connection of this server and
 * everything that rides on it:
 *
 * - MM-1303: one outbound WebSocket to `<portal>/connect`, with backoff after a failure.
 * - MM-603, MM-607, MM-1304: each desired state is saved, then applied. The saved one applies
 *   again at start, before the server accepts requests.
 * - MM-402, MM-404: server settings apply through the settings service. A change made on this
 *   machine outside the map goes to the portal as `localSettings`.
 * - MM-305, MM-1306: a level change of an arrow into this machine ends the sessions of its peer.
 * - MM-501, MM-1402: commands run here, or wait for the desktop app.
 * - MM-1001, MM-1002: status on connection and on change, at most once every 5 seconds.
 * - MM-1501: a resource sample on connection, every minute, and when the portal asks.
 * - MM-801, MM-805: agent tools that run through the portal.
 * - The client stream for the desktop app and web Settings (`machineMapClient.ts`).
 */
import {
  MACHINE_MAP_PROTOCOL,
  type MachineCommand,
  type MachineDesiredState,
  type MachineMapClientState,
  type MachineMapDesktopReport,
  type MachineMapJoinInput,
  type MachineMapPanelState,
  type MachineMapShareSettingsInput,
  type MachineMapShareSettingsResult,
  MachinesReadResult,
  MachineMapRequestError,
  type MachineStatus,
  type MachineToPortal,
  MachineTunnelGrant,
  type MapToolName,
  type OrchestrationV2DomainEvent,
  ServerSettings as ServerSettingsSchema,
  ServerSettingsPatch,
  type SettingValues,
  TrimmedNonEmptyString,
  isMachineLocalSetting,
  clientSessionSubject,
  machineSessionSubject,
  withoutMachineLocalSettings,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerConfig from "../../config.ts";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  clientsWithChangedLevel,
  isMapSubject,
  nextExpiry,
  peersWithChangedLevel,
  reachablePeers,
} from "./machineAccess.ts";
import * as MachineHost from "./MachineHost.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachineResources from "./MachineResources.ts";
import * as MachineTunnel from "./MachineTunnel.ts";
import { applyThemeSettings, THEME_SETTING_KEYS, withSharedThemes } from "./themeSync.ts";
import {
  PORTAL_CLOSE_CODES,
  type PortalMessage,
  runPortalSession,
  type SendToPortal,
} from "./portalConnection.ts";

/** MM-1001: the status goes out at most this often. */
const STATUS_MIN_INTERVAL = Duration.seconds(5);
/** Host load can change without any event, so the status is checked this often too. */
const STATUS_IDLE_CHECK = Duration.minutes(1);
/** MM-1306: a failed session revocation runs again this often. */
const REVOKE_RETRY_INTERVAL = Duration.seconds(30);
/** MM-1501: one resource sample a minute, and one on request at most every 10 seconds. */
const DESKTOP_COMMAND_EXPIRY_CHECK = Duration.minutes(1);
const RESOURCE_INTERVAL = Duration.minutes(1);
const RESOURCE_REQUEST_GAP_MS = 10_000;
const TOOL_CALL_TIMEOUT = Duration.seconds(30);
const ENROLL_TIMEOUT = Duration.seconds(20);
const MAX_BACKOFF_MS = 60_000;
/** A connection that stayed open this long resets the backoff. */
const HEALTHY_CONNECTION_MS = 30_000;

/** Thread events that can change the running or waiting counts of the status. */
const STATUS_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "plan.updated",
]);

/**
 * What `/enroll` returns for a valid join code (MM-204). The portal adds fields at will; the
 * machine needs the token and the tunnel (MM-213).
 */
const EnrollResponse = Schema.Struct({
  tokenClientId: TrimmedNonEmptyString,
  tokenSecret: TrimmedNonEmptyString,
  tunnel: Schema.optionalKey(Schema.NullOr(MachineTunnelGrant)),
});
/**
 * MM-211: the installer leaves a join code in `<stateDir>/machine-map-join-code` for the desktop
 * app. The server joins with it at start.
 */
const PENDING_JOIN_FILE = "machine-map-join-code";
/** Time for the join answer to reach the caller before the restart for the tunnel. */
const TUNNEL_RESTART_DELAY = Duration.seconds(2);
const EnrollRefusal = Schema.Struct({ error: Schema.optionalKey(Schema.String) });

const decodePatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeMachinesRead = Schema.decodeUnknownEffect(MachinesReadResult);
const encodeServerSettings = Schema.encodeEffect(ServerSettingsSchema);

export class MachineMapToolError extends Schema.TaggedError<MachineMapToolError>()(
  "MachineMapToolError",
  {
    reason: Schema.Literals(["not-connected", "timed-out", "refused"]),
    /** A message safe to show to the agent, such as the refusal of the portal. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

interface DesktopReportState {
  readonly updateWaiting: string | null;
  readonly build: string | null;
  readonly clientSettings: SettingValues | null;
}

type ToolResult = Extract<PortalMessage, { readonly _tag: "toolResult" }>;

export class MachineMap extends Context.Service<
  MachineMap,
  {
    /** MM-203, MM-204: exchange a join code at `<portal>/enroll` and turn the map on. */
    readonly join: (
      input: MachineMapJoinInput,
    ) => Effect.Effect<MachineMapClientState, MachineMapRequestError>;
    /** Turns the map off, forgets the token and the desired state, and ends machine sessions. */
    readonly leave: Effect.Effect<MachineMapClientState, MachineMapRequestError>;
    /**
     * The state for one client, then again on each change. Only `desktop` (a `desktop-bootstrap`
     * session) gets the token headers and the desktop commands.
     */
    readonly clientStates: (client: {
      readonly desktop: boolean;
    }) => Stream.Stream<MachineMapClientState>;
    readonly reportDesktop: (
      report: MachineMapDesktopReport,
      client: { readonly desktop: boolean },
    ) => Effect.Effect<void, MachineMapRequestError>;
    /** MM-801, MM-805: one agent tool through the portal, which checks the map role. */
    readonly callMapTool: (input: {
      readonly tool: MapToolName;
      readonly input: unknown;
      readonly threadId: string | null;
      readonly threadTitle: string | null;
    }) => Effect.Effect<unknown, MachineMapToolError>;
    /** MM-1701: the map for the Machines panel, or why there is none. */
    readonly readPanel: Effect.Effect<MachineMapPanelState>;
    /** MM-411: sends settings saved for all environments to the portal as shared values. */
    readonly shareSettings: (
      input: MachineMapShareSettingsInput,
    ) => Effect.Effect<MachineMapShareSettingsResult>;
  }
>()("t3/fork/machineMap/MachineMap") {}

const make = Effect.gen(function* () {
  const state = yield* MachineMapState.MachineMapState;
  const host = yield* MachineHost.MachineHost;
  const tunnel = yield* MachineTunnel.MachineTunnel;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resources = yield* MachineResources.MachineResources;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessionStore = yield* SessionStore.SessionStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;

  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const connection = yield* SubscriptionRef.make<{
    readonly online: boolean;
    readonly since: string;
    readonly lastError: string | null;
    readonly failedAttempts: number;
  }>({ online: false, since: startedAt, lastError: null, failedAttempts: 0 });
  const currentSend = yield* Ref.make<SendToPortal | null>(null);
  /** Results and local changes that wait for the next connection. Lost on restart. */
  const outbox = yield* Ref.make<ReadonlyArray<MachineToPortal>>([]);
  const pendingToolCalls = new Map<string, Deferred.Deferred<ToolResult, MachineMapToolError>>();
  const desktopReport = yield* Ref.make<DesktopReportState>({
    updateWaiting: null,
    build: null,
    clientSettings: null,
  });
  const desktopSubscribers = yield* SubscriptionRef.make(0);
  const statusDirty = yield* Queue.sliding<void>(1);
  const markStatusDirty = Queue.offer(statusDirty, undefined).pipe(Effect.asVoid);
  const lastSentStatus = yield* Ref.make<string | null>(null);
  const lastResourceSampleAt = yield* Ref.make(0);
  /** The encoded server settings that the last report saw, by key (MM-404). */
  const settingsBaseline = yield* Ref.make<Readonly<Record<string, unknown>>>({});

  // --- Portal messages -----------------------------------------------------------------------

  const sendOrQueue = (message: MachineToPortal) =>
    Effect.gen(function* () {
      const send = yield* Ref.get(currentSend);
      const sent =
        send === null
          ? false
          : yield* send(message).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
      if (!sent) yield* Ref.update(outbox, (queued) => [...queued, message]);
    });

  const statusInput = Effect.gen(function* () {
    const report = yield* Ref.get(desktopReport);
    return {
      desktopConnected: (yield* SubscriptionRef.get(desktopSubscribers)) > 0,
      updateWaiting: report.updateWaiting,
      desktopBuild: report.build,
    } satisfies MachineHost.StatusInput;
  });
  // Uptime always moves; it alone is not a change.
  const statusKey = (status: MachineStatus) => stableStringify({ ...status, uptimeSeconds: 0 });

  /**
   * The settings as the portal sees them: encoded, secrets redacted, without the machine-local
   * keys (MM-406), with the published themes (MM-408).
   */
  const reportedServerSettings = (current: typeof ServerSettingsSchema.Type) =>
    Effect.gen(function* () {
      const encoded = yield* encodeServerSettings(
        ServerSettings.redactServerSettingsForClient(current),
      );
      return withSharedThemes(
        withoutMachineLocalSettings("server", encoded as Record<string, unknown>),
        yield* environmentThemes.current,
      );
    });

  // --- MM-402: apply the server settings of a desired state ----------------------------------

  const applyServerSettings = (values: SettingValues) =>
    Effect.gen(function* () {
      const current = yield* reportedServerSettings(yield* settings.getSettings);
      const changed: Record<string, unknown> = {};
      const changedThemeSettings: Record<string, unknown> = {};
      const skipped: Array<string> = [];
      for (const [key, value] of Object.entries(values)) {
        if (THEME_SETTING_KEYS.has(key)) {
          if (stableStringify(current[key]) !== stableStringify(value)) {
            changedThemeSettings[key] = value;
          }
          continue;
        }
        if (
          isMachineLocalSetting("server", key) ||
          !Object.hasOwn(ServerSettingsPatch.fields, key)
        ) {
          skipped.push(key);
          continue;
        }
        if (stableStringify(current[key]) === stableStringify(value)) continue;
        // One bad value must not block the others.
        const valid = yield* decodePatch({ [key]: value }).pipe(Effect.isSuccess);
        if (valid) changed[key] = value;
        else skipped.push(key);
      }
      if (skipped.length > 0) {
        yield* Effect.logWarning("Machine map skipped settings that do not apply here.", {
          keys: skipped,
        });
      }
      if (Object.keys(changed).length > 0) {
        yield* settings.updateSettings(yield* decodePatch(changed));
      }
      // After the patch: `t3 theme set` merges into the settings file that the patch wrote.
      yield* applyThemeSettings({
        settingsPath: config.settingsPath,
        themesDir: config.environmentThemesDir,
        changed: changedThemeSettings,
        current,
      });
    });

  // --- MM-1306: end the sessions of peers whose level changed --------------------------------

  const revokeSessions = (matches: (subject: string) => boolean) =>
    Effect.gen(function* () {
      const sessions = yield* auth.listSessions();
      yield* Effect.forEach(
        sessions.filter((session) => matches(session.subject)),
        (session) => auth.revokeSession(session.sessionId),
        { discard: true },
      );
      // A pairing credential issued under the old level must not become a session either.
      const links = yield* auth.listPairingLinks({ excludeSubjects: [] });
      yield* Effect.forEach(
        links.filter((link) => matches(link.subject)),
        (link) => auth.revokePairingLink(link.id),
        { discard: true },
      );
    });

  // One revocation pass at a time. Without it, a pass could clear a subject that a later desired
  // state added again after the pass ended its sessions, and a session at the old level stays.
  const revokeLock = yield* Semaphore.make(1);

  /** Ends the sessions of the saved `pendingRevokes`, then clears the ones that ended. */
  const revokePendingUnlocked = Effect.gen(function* () {
    const pending = new Set((yield* state.snapshot).saved.pendingRevokes);
    if (pending.size === 0) return;
    yield* revokeSessions((subject) => pending.has(subject));
    yield* state.updateSaved((saved) => ({
      ...saved,
      pendingRevokes: saved.pendingRevokes.filter((subject) => !pending.has(subject)),
    }));
  });
  const revokePending = revokeLock.withPermits(1)(revokePendingUnlocked);

  /**
   * MM-1306: ends the sessions of these subjects. They stay in `pendingRevokes` until that works,
   * so a failure runs again with the next desired state or the retry loop.
   */
  const endSessionsOf = (subjects: ReadonlyArray<string>) =>
    revokeLock.withPermits(1)(
      Effect.gen(function* () {
        if (subjects.length > 0) {
          yield* state.updateSaved((saved) => ({
            ...saved,
            pendingRevokes: [...new Set([...saved.pendingRevokes, ...subjects])],
          }));
        }
        yield* revokePendingUnlocked;
      }),
    );

  /**
   * MM-1301: ends every machine and client session and pairing link, through `pendingRevokes`,
   * so a failure runs again also while the map is off.
   */
  const endAllMapSessions = Effect.gen(function* () {
    const sessions = yield* auth.listSessions();
    const links = yield* auth.listPairingLinks({ excludeSubjects: [] });
    yield* endSessionsOf(
      [...sessions, ...links]
        .map((item) => item.subject)
        .filter((subject) => isMapSubject(subject)),
    );
  });

  const applyDesired = (desired: MachineDesiredState) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const { desired: before, desiredAtMs: beforeAtMs } = (yield* state.snapshot).saved;
      const changed = [
        ...peersWithChangedLevel(before, beforeAtMs, desired, nowMs).map((peer) =>
          machineSessionSubject(peer),
        ),
        // MM-912: a client whose level changed pairs again with its app token, or not at all.
        ...clientsWithChangedLevel(before, beforeAtMs, desired, nowMs).map((id) =>
          clientSessionSubject(id),
        ),
      ];
      // Save first: the auth hooks read the saved state, so the new levels hold before any
      // session of a changed peer ends and it pairs again. The subjects to end are saved in the
      // same write, so a failed revocation is not lost.
      yield* revokeLock.withPermits(1)(
        Effect.gen(function* () {
          yield* state.updateSaved((saved) => ({
            ...saved,
            desired,
            desiredAtMs: nowMs,
            pendingRevokes: [...new Set([...saved.pendingRevokes, ...changed])],
          }));
          // A stuck revocation must not hold back the settings; the retry loop runs it again.
          yield* revokePendingUnlocked.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Machine map could not end sessions; it tries again.", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }),
      );
      yield* applyServerSettings(desired.settings.server);
      // Client settings reach the desktop app through the client stream (MM-403).
    });

  // --- Commands ------------------------------------------------------------------------------

  const expireDesktopCommands = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const expired = (yield* state.snapshot).saved.desktopCommands.filter(
      (command) => Date.parse(command.expiresAt) <= nowMs,
    );
    if (expired.length === 0) return;
    const ids = new Set(expired.map((command) => command.id));
    yield* state.updateSaved((saved) => ({
      ...saved,
      desktopCommands: saved.desktopCommands.filter((command) => !ids.has(command.id)),
    }));
    yield* Effect.forEach(
      expired,
      (command) =>
        sendOrQueue({
          _tag: "commandResult",
          commandId: command.id,
          ok: false,
          result: null,
          error: "Expired before the desktop app ran it.",
        }),
      { discard: true },
    );
  });

  const handleCommand = (command: MachineCommand) =>
    Effect.gen(function* () {
      const local = yield* state.snapshot;
      if (local.saved.handledCommandIds.includes(command.id)) return;
      if (host.isDesktopCommand(command.input._tag)) {
        // MM-1402: it waits for the desktop app, which reports its result.
        yield* state.updateSaved((saved) => ({
          ...saved,
          desktopCommands: [
            ...saved.desktopCommands.filter((queued) => queued.id !== command.id),
            command,
          ],
        }));
        yield* state.rememberCommand(command.id);
        return;
      }
      // Remember it before it runs, so a restart from `restartServer` does not run it again.
      yield* state.rememberCommand(command.id);
      const outcome = yield* host.run(command);
      yield* sendOrQueue({
        _tag: "commandResult",
        commandId: command.id,
        ok: outcome.ok,
        result: outcome.result ?? null,
        error: outcome.error,
      });
      if (outcome.restartAfterReply === true) {
        // Give the socket a moment to flush the result.
        yield* Effect.sleep(Duration.millis(500));
        yield* host.restartProcess;
      }
      yield* markStatusDirty;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Machine map command failed.", {
          commandId: command.id,
          kind: command.input._tag,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  // --- MM-1501: resource samples ------------------------------------------------------------

  // A sample that does not go out is not queued: the next one comes within a minute.
  const sendResources = (send: SendToPortal) =>
    Effect.gen(function* () {
      const sample = yield* resources.sample;
      yield* Ref.set(lastResourceSampleAt, yield* Clock.currentTimeMillis);
      yield* send({ _tag: "resources", sample }).pipe(Effect.ignore);
    });

  const resourceLoop = (send: SendToPortal) =>
    Effect.gen(function* () {
      while (true) {
        yield* sendResources(send);
        yield* Effect.sleep(RESOURCE_INTERVAL);
      }
    });

  const onPortalMessage = (send: SendToPortal) => (message: PortalMessage) =>
    Effect.gen(function* () {
      switch (message._tag) {
        case "desired": {
          yield* applyDesired(message.state).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Machine map could not apply the desired state.", {
                revision: message.state.revision,
                cause: Cause.pretty(cause),
              }),
            ),
          );
          yield* send({ _tag: "applied", revision: message.state.revision }).pipe(Effect.ignore);
          return;
        }
        case "command": {
          // A command can take long; the connection keeps reading meanwhile.
          yield* Effect.forkIn(handleCommand(message.command), scope);
          return;
        }
        case "toolResult": {
          const pending = pendingToolCalls.get(message.requestId);
          if (pending !== undefined) yield* Deferred.succeed(pending, message);
          return;
        }
        case "sampleResources": {
          const nowMs = yield* Clock.currentTimeMillis;
          if (nowMs - (yield* Ref.get(lastResourceSampleAt)) < RESOURCE_REQUEST_GAP_MS) return;
          // Sampling takes a moment; the connection keeps reading meanwhile.
          yield* Effect.forkScoped(sendResources(send));
          return;
        }
        case "rotate": {
          // MM-207: save the new secret, then confirm. The next connection uses it.
          yield* state
            .setToken({ clientId: message.tokenClientId, secret: message.tokenSecret })
            .pipe(
              Effect.andThen(send({ _tag: "rotated", tokenClientId: message.tokenClientId })),
              Effect.catchCause((cause) =>
                Effect.logWarning("Machine map could not save the rotated token.", {
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          return;
        }
      }
    });

  const onPortalOpen = (send: SendToPortal) =>
    Effect.gen(function* () {
      const local = yield* state.snapshot;
      const status = yield* host.status(yield* statusInput);
      const report = yield* Ref.get(desktopReport);
      const server = yield* reportedServerSettings(yield* settings.getSettings).pipe(
        Effect.orElseSucceed(() => ({})),
      );
      yield* send({
        _tag: "hello",
        protocol: MACHINE_MAP_PROTOCOL,
        appliedRevision: local.saved.desired?.revision ?? null,
        status,
        // Client settings reach the portal once the desktop app reported them (MM-405).
        settings: {
          server,
          client: withoutMachineLocalSettings("client", report.clientSettings ?? {}),
        },
      });
      yield* Ref.set(lastSentStatus, statusKey(status));
      yield* Ref.set(currentSend, send);
      const openedAt = DateTime.formatIso(yield* DateTime.now);
      yield* SubscriptionRef.set(connection, {
        online: true,
        since: openedAt,
        lastError: null,
        failedAttempts: 0,
      });
      const queued = yield* Ref.getAndSet(outbox, []);
      for (const message of queued) yield* sendOrQueue(message);
      // Status triggers live as long as this session, so a server off the map does no work.
      yield* Effect.forkScoped(statusTriggers);
      yield* Effect.forkScoped(resourceLoop(send));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Machine map could not greet the portal.", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const failPendingToolCalls = Effect.gen(function* () {
    for (const [requestId, deferred] of pendingToolCalls) {
      pendingToolCalls.delete(requestId);
      yield* Deferred.fail(
        deferred,
        new MachineMapToolError({
          reason: "not-connected",
          detail: "The portal connection closed before the answer came.",
        }),
      );
    }
  });

  /**
   * Forgets the token, the desired state and the desktop commands, and ends machine and client
   * sessions.
   * The token goes last: its change restarts the connection fiber, which may be the caller.
   */
  const forgetMap = Effect.gen(function* () {
    yield* state.updateSaved((saved) => ({
      ...saved,
      desired: null,
      desiredAtMs: null,
      desktopCommands: [],
    }));
    yield* endAllMapSessions.pipe(Effect.ignore({ log: true }));
    yield* state.setToken(null);
  });

  const markOffline = Effect.gen(function* () {
    yield* Ref.set(currentSend, null);
    yield* failPendingToolCalls;
    yield* SubscriptionRef.update(connection, (current) => ({ ...current, online: false }));
  });

  /** Sessions with the portal until the key changes. Each failure waits longer, up to a minute. */
  const runConnection = (portalUrl: string) =>
    Effect.gen(function* () {
      let failures = 0;
      while (true) {
        const token = (yield* state.snapshot).token;
        if (token === null) return;
        const openedAtMs = yield* Ref.make<number | null>(null);
        const ended = yield* runPortalSession({
          portalUrl,
          token,
          onOpen: (send) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((nowMs) => Ref.set(openedAtMs, nowMs)),
              Effect.andThen(onPortalOpen(send)),
            ),
          onMessage: (message, send) => onPortalMessage(send)(message),
        }).pipe(
          Effect.flip,
          // Only an interrupt (a new key, or shutdown) ends the loop; anything else retries.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed({
                  reason: "failed",
                  message: Cause.pretty(cause).slice(0, 300),
                  closeCode: null,
                }),
          ),
        );
        yield* markOffline;
        const nowMs = yield* Clock.currentTimeMillis;
        const openedAt = yield* Ref.get(openedAtMs);
        // A connection that the portal drops at once counts as a failure too. So does a
        // replacement: two servers with one token must not take turns every second.
        failures =
          openedAt !== null &&
          nowMs - openedAt >= HEALTHY_CONNECTION_MS &&
          ended.closeCode !== PORTAL_CLOSE_CODES.replaced
            ? 0
            : failures + 1;
        yield* SubscriptionRef.set(connection, {
          online: false,
          since: DateTime.formatIso(yield* DateTime.now),
          lastError:
            ended.closeCode === PORTAL_CLOSE_CODES.removed
              ? "The portal removed this machine from the map. Join again with a new code."
              : ended.message,
          failedAttempts: failures,
        });
        yield* Effect.logInfo("Machine map portal connection ended.", {
          reason: ended.reason,
          closeCode: ended.closeCode,
          failures,
        });
        if (ended.closeCode === PORTAL_CLOSE_CODES.removed) {
          // MM-208: the old token never connects again, so retrying only adds noise.
          yield* forgetMap.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Machine map could not forget a removed machine.", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
          return;
        }
        const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures, 6));
        const jitter = yield* Random.nextIntBetween(0, Math.floor(base / 4) + 1);
        // Another protocol version stays another version until this server updates.
        const delayMs =
          ended.closeCode === PORTAL_CLOSE_CODES.protocol
            ? MAX_BACKOFF_MS
            : failures === 0
              ? 1_000
              : base + jitter;
        yield* Effect.sleep(Duration.millis(delayMs));
      }
    }).pipe(Effect.ensuring(markOffline));

  /** One connection per portal and token: a join with another token or URL starts over. */
  const connectionKey = (local: MachineMapState.LocalState) =>
    local.enabled && local.token !== null ? `${local.portalUrl}\n${local.token.clientId}` : null;

  const superviseConnection = state.changes.pipe(
    Stream.map((local) => ({
      key: connectionKey(local),
      portalUrl: local.portalUrl,
      enabled: local.enabled,
    })),
    Stream.changesWith((left, right) => left.key === right.key && left.enabled === right.enabled),
    Stream.mapAccum(
      () => true,
      (wasEnabled, next) => [next.enabled, [{ ...next, turnedOff: wasEnabled && !next.enabled }]],
    ),
    Stream.switchMap((next) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          if (next.turnedOff) {
            // MM-1301: off means no change to auth, so no machine or client session stays.
            yield* endAllMapSessions.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Machine map could not end machine sessions.", {
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }
          if (next.key !== null) yield* runConnection(next.portalUrl);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Machine map connection stopped.", {
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      ),
    ),
    Stream.runDrain,
  );

  // --- MM-304, MM-912: an arrow that expires ends its sessions at its expiry -----------------

  /**
   * MM-916: when `clientAccess` leaves `observe`, the sessions of browser clients end, so `off`
   * is the owner login of MM-308 again. A client that also holds an app token pairs again with it.
   */
  const watchClientAccess = state.changes.pipe(
    Stream.map((local) => local.clientAccess),
    Stream.changes,
    Stream.mapAccum(
      (): MachineMapState.LocalState["clientAccess"] | undefined => undefined,
      (previous, next) => [next, previous === "observe" && next !== "observe" ? [next] : []],
    ),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const desired = (yield* state.snapshot).saved.desired;
        const subjects = new Set(
          (desired?.browserClients ?? []).map((client) => clientSessionSubject(client.id)),
        );
        yield* endSessionsOf([...subjects]);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Machine map could not end browser client sessions.", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );

  /**
   * Sleeps until the next arrow expiry of the saved desired state, then ends the sessions of that
   * source, also while the portal is unreachable. A new desired state starts it again from its
   * arrival, because `applyDesired` handled every expiry before that. After a restart it starts
   * from the arrival of the saved state, so an expiry during the downtime ends its sessions too;
   * one that ended them before the restart ends the newer sessions of that source once more.
   */
  const watchExpiries = state.changes.pipe(
    Stream.map((local) =>
      local.enabled ? { desired: local.saved.desired, atMs: local.saved.desiredAtMs } : null,
    ),
    Stream.changesWith((left, right) => left?.desired === right?.desired),
    Stream.switchMap((current) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const desired = current?.desired ?? null;
          if (desired === null) return;
          let afterMs = current?.atMs ?? (yield* Clock.currentTimeMillis);
          for (;;) {
            const next = nextExpiry(desired, afterMs);
            if (next === undefined) return;
            const waitMs = next.atMs - (yield* Clock.currentTimeMillis);
            if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
            yield* endSessionsOf(next.subjects).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Machine map could not end the sessions of an expired arrow.", {
                  cause: Cause.pretty(cause),
                }),
              ),
            );
            afterMs = next.atMs;
          }
        }),
      ),
    ),
    Stream.runDrain,
  );

  // --- MM-404: settings that change outside the map ------------------------------------------

  // A change in the themes folder is a change of `sharedThemes` (MM-408).
  const watchLocalSettings = Stream.merge(
    settings.streamChanges.pipe(Stream.as(undefined)),
    environmentThemes.streamChanges.pipe(Stream.as(undefined)),
  ).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const next = yield* reportedServerSettings(yield* settings.getSettings);
        const before = yield* Ref.getAndSet(settingsBaseline, next);
        const local = yield* state.snapshot;
        if (!local.enabled || local.saved.desired === null) return;
        const desired = local.saved.desired.settings.server;
        const changed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(next)) {
          if (stableStringify(before[key]) === stableStringify(value)) continue;
          // The map wrote this value itself: not a local change, so no echo.
          if (
            Object.hasOwn(desired, key) &&
            stableStringify(desired[key]) === stableStringify(value)
          ) {
            continue;
          }
          changed[key] = value;
        }
        if (Object.keys(changed).length > 0) {
          yield* sendOrQueue({ _tag: "localSettings", scope: "server", values: changed });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Machine map could not compare settings.", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );

  // --- MM-1001, MM-1002: status --------------------------------------------------------------

  const statusLoop = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(statusDirty);
      const send = yield* Ref.get(currentSend);
      if (send !== null) {
        const status = yield* host.status(yield* statusInput);
        const key = statusKey(status);
        if (key !== (yield* Ref.get(lastSentStatus))) {
          const sent = yield* send({ _tag: "status", status }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (sent) yield* Ref.set(lastSentStatus, key);
        }
      }
      yield* Effect.sleep(STATUS_MIN_INTERVAL);
    }
  });

  const statusTriggers = Stream.mergeAll(
    [
      threads.streamDomainEvents.pipe(
        Stream.filter((event) => STATUS_EVENT_TYPES.has(event.type)),
        Stream.as(undefined),
      ),
      sessionStore.streamChanges.pipe(Stream.as(undefined)),
      scheduledTasks.subscribeList().pipe(Stream.ignore({ log: true }), Stream.as(undefined)),
      SubscriptionRef.changes(desktopSubscribers).pipe(Stream.as(undefined)),
      Stream.tick(STATUS_IDLE_CHECK),
    ],
    { concurrency: "unbounded" },
  ).pipe(Stream.runForEach(() => markStatusDirty));

  // --- Client stream -------------------------------------------------------------------------

  const clientState = (desktop: boolean) =>
    Effect.gen(function* () {
      const local = yield* state.snapshot;
      const current = yield* SubscriptionRef.get(connection);
      const nowMs = yield* Clock.currentTimeMillis;
      const active = local.enabled && local.token !== null;
      return {
        enabled: local.enabled,
        portalUrl: local.portalUrl,
        joined: local.token !== null,
        connection: {
          status: !local.enabled
            ? "off"
            : local.token === null
              ? "not-joined"
              : current.online
                ? "online"
                : "connecting",
          since: current.since,
          lastError: local.enabled ? current.lastError : null,
          failedAttempts: active ? current.failedAttempts : 0,
        },
        desired: local.saved.desired,
        reachable: local.enabled ? reachablePeers(local.saved.desired, nowMs) : [],
        tokenHeaders:
          desktop && local.enabled && local.token !== null
            ? MachineMapState.tokenHeaders(local.token)
            : null,
        desktopCommands: desktop ? local.saved.desktopCommands : [],
      } satisfies MachineMapClientState;
    });

  const clientStates: MachineMap["Service"]["clientStates"] = ({ desktop }) => {
    const states = Stream.merge(
      state.changes.pipe(Stream.as(undefined)),
      SubscriptionRef.changes(connection).pipe(Stream.as(undefined)),
    ).pipe(
      Stream.mapEffect(() => clientState(desktop)),
      Stream.changesWith((left, right) => stableStringify(left) === stableStringify(right)),
    );
    // A listening desktop app is what makes the desktop commands possible (MM-502).
    return desktop
      ? states.pipe(
          Stream.onStart(SubscriptionRef.update(desktopSubscribers, (count) => count + 1)),
          Stream.ensuring(SubscriptionRef.update(desktopSubscribers, (count) => count - 1)),
        )
      : states;
  };

  const reportDesktop: MachineMap["Service"]["reportDesktop"] = (report, client) =>
    Effect.gen(function* () {
      if (!client.desktop) {
        return yield* new MachineMapRequestError({
          reason: "desktop-only",
          detail: "Only the desktop app of this machine reports to it.",
        });
      }
      const previous = yield* Ref.get(desktopReport);
      yield* Ref.set(desktopReport, {
        updateWaiting:
          report.updateWaiting === undefined ? previous.updateWaiting : report.updateWaiting,
        build: report.build === undefined ? previous.build : report.build,
        clientSettings: report.clientSettings ?? previous.clientSettings,
      });
      if (report.commandResult !== undefined) {
        const result = report.commandResult;
        yield* state
          .updateSaved((saved) => ({
            ...saved,
            desktopCommands: saved.desktopCommands.filter(
              (command) => command.id !== result.commandId,
            ),
          }))
          .pipe(
            Effect.mapError(
              () =>
                new MachineMapRequestError({
                  reason: "storage-failed",
                  detail: "Could not save the machine map state.",
                }),
            ),
          );
        yield* sendOrQueue({ _tag: "commandResult", ...result });
      }
      // MM-404 for client settings. Values equal to the desired ones are the map's own writes.
      if (report.clientSettings !== undefined && previous.clientSettings !== null) {
        const desired = (yield* state.snapshot).saved.desired?.settings.client ?? {};
        const changed: Record<string, unknown> = {};
        const current = withoutMachineLocalSettings("client", report.clientSettings);
        for (const [key, value] of Object.entries(current)) {
          if (stableStringify(previous.clientSettings[key]) === stableStringify(value)) continue;
          if (
            Object.hasOwn(desired, key) &&
            stableStringify(desired[key]) === stableStringify(value)
          ) {
            continue;
          }
          changed[key] = value;
        }
        if (Object.keys(changed).length > 0) {
          yield* sendOrQueue({ _tag: "localSettings", scope: "client", values: changed });
        }
      }
      yield* markStatusDirty;
    });

  // --- Join and leave ------------------------------------------------------------------------

  const storageFailed = () =>
    new MachineMapRequestError({
      reason: "storage-failed",
      detail: "Could not save the machine map state or token.",
    });
  const settingsFailed = () =>
    new MachineMapRequestError({
      reason: "settings-failed",
      detail: "Could not save the machineMap setting.",
    });

  const join: MachineMap["Service"]["join"] = (input) =>
    Effect.gen(function* () {
      const portalUrl = input.portalUrl ?? (yield* state.snapshot).portalUrl;
      const enrollUrl = yield* Effect.try({
        try: () => {
          const url = new URL("/enroll", portalUrl);
          if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
          return url.toString();
        },
        catch: () =>
          new MachineMapRequestError({
            reason: "portal-unreachable",
            detail: `"${portalUrl}" is not an http or https URL.`,
          }),
      });
      const response = yield* HttpClientRequest.post(enrollUrl).pipe(
        HttpClientRequest.bodyJson({ code: input.code }),
        Effect.flatMap(httpClient.execute),
        Effect.timeout(ENROLL_TIMEOUT),
        Effect.mapError(
          () =>
            new MachineMapRequestError({
              reason: "portal-unreachable",
              detail: `Could not reach ${new URL(enrollUrl).host}.`,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const refusal = yield* HttpClientResponse.schemaBodyJson(EnrollRefusal)(response).pipe(
          Effect.map((body) => body.error),
          Effect.orElseSucceed(() => undefined),
        );
        return yield* new MachineMapRequestError({
          reason: "join-refused",
          detail: (refusal ?? `The portal answered HTTP ${response.status}.`).slice(0, 300),
        });
      }
      const enrolled = yield* HttpClientResponse.schemaBodyJson(EnrollResponse)(response).pipe(
        Effect.mapError(
          () =>
            new MachineMapRequestError({
              reason: "join-refused",
              detail: "The portal answer holds no machine token.",
            }),
        ),
      );
      // The error of an old connection does not apply to the new token. This goes first,
      // because the saved token starts the new connection.
      yield* SubscriptionRef.set(connection, {
        online: false,
        since: DateTime.formatIso(yield* DateTime.now),
        lastError: null,
        failedAttempts: 0,
      });
      yield* state
        .setToken({ clientId: enrolled.tokenClientId, secret: enrolled.tokenSecret })
        .pipe(Effect.mapError(storageFailed));
      yield* settings
        .updateSettings({ machineMap: { enabled: true, portalUrl } })
        .pipe(Effect.mapError(settingsFailed));
      yield* Effect.logInfo("Machine map joined.", { portal: new URL(portalUrl).host });
      // MM-1309: the config reads the tunnel at start, so a new tunnel needs a restart.
      if (enrolled.tunnel && (yield* tunnel.adopt(enrolled.tunnel)) === "restart") {
        if (host.supervised) {
          yield* Effect.sleep(TUNNEL_RESTART_DELAY).pipe(
            Effect.andThen(host.restartProcess),
            Effect.forkIn(scope),
          );
        } else {
          yield* Effect.logWarning("Restart the T3 server to start the machine map tunnel.");
        }
      }
      return yield* clientState(false);
    });

  const leave: MachineMap["Service"]["leave"] = Effect.gen(function* () {
    yield* settings
      .updateSettings({ machineMap: { enabled: false } })
      .pipe(Effect.mapError(settingsFailed));
    yield* forgetMap.pipe(Effect.mapError(storageFailed));
    yield* tunnel.forget;
    // Return once the portal connection is closed, so no later call goes out on it.
    yield* SubscriptionRef.changes(connection).pipe(
      Stream.filter((current) => !current.online),
      Stream.runHead,
      Effect.timeout(Duration.seconds(5)),
      Effect.ignore,
    );
    return yield* clientState(false);
  });

  // --- Map tools -----------------------------------------------------------------------------

  const callMapTool: MachineMap["Service"]["callMapTool"] = (input) =>
    Effect.gen(function* () {
      const send = yield* Ref.get(currentSend);
      if (send === null) {
        return yield* new MachineMapToolError({
          reason: "not-connected",
          detail:
            "This machine has no portal connection now. Join the machine map, or wait until it connects again.",
        });
      }
      const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const answer = yield* Deferred.make<ToolResult, MachineMapToolError>();
      pendingToolCalls.set(requestId, answer);
      const result = yield* send({
        _tag: "toolCall",
        requestId,
        tool: input.tool,
        input: input.input,
        threadId: input.threadId,
        threadTitle: input.threadTitle,
      }).pipe(
        Effect.mapError(
          () =>
            new MachineMapToolError({
              reason: "not-connected",
              detail: "The portal connection closed before the call went out.",
            }),
        ),
        Effect.andThen(Deferred.await(answer)),
        Effect.timeoutOrElse({
          duration: TOOL_CALL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new MachineMapToolError({
                reason: "timed-out",
                detail: "The portal did not answer within 30 seconds.",
              }),
            ),
        }),
        Effect.ensuring(Effect.sync(() => pendingToolCalls.delete(requestId))),
      );
      if (!result.ok) {
        return yield* new MachineMapToolError({
          reason: "refused",
          detail: result.error ?? "The portal refused the call.",
        });
      }
      return result.result;
    });

  const unavailable = (
    reason: Extract<MachineMapPanelState, { readonly _tag: "unavailable" }>["reason"],
    detail: string,
  ): MachineMapPanelState => ({ _tag: "unavailable", reason, detail });

  const readPanel: MachineMap["Service"]["readPanel"] = Effect.gen(function* () {
    const local = yield* state.snapshot;
    if (!local.enabled || local.token === null) {
      return unavailable("off", "This machine is not on the machine map. Join it in Settings.");
    }
    if (local.saved.desired?.paused === true) {
      return unavailable("paused", "The emergency pause is on. Only the owner can resume it.");
    }
    return yield* callMapTool({
      tool: "machines_read",
      input: {},
      threadId: null,
      threadTitle: null,
    }).pipe(
      Effect.flatMap(decodeMachinesRead),
      Effect.catchTags({
        MachineMapToolError: (error) => Effect.succeed(unavailable(error.reason, error.detail)),
        SchemaError: (error) =>
          Effect.logWarning("Machine map read result is unreadable.", {
            cause: String(error),
          }).pipe(
            Effect.as(unavailable("unreadable", "The portal answered with an unknown format.")),
          ),
      }),
    );
  });

  /**
   * MM-411: only while connected. A queued share could arrive after a newer shared value, so a
   * change made offline stays the bulk edit of T3 Settings.
   */
  const shareSettings: MachineMap["Service"]["shareSettings"] = (input) =>
    Effect.gen(function* () {
      const local = yield* state.snapshot;
      const send = yield* Ref.get(currentSend);
      if (!local.enabled || local.saved.desired === null || send === null) return { shared: false };
      const saved = yield* reportedServerSettings(yield* settings.getSettings);
      const server = Object.fromEntries(
        input.server.flatMap((key) => (Object.hasOwn(saved, key) ? [[key, saved[key]]] : [])),
      );
      const client = withoutMachineLocalSettings("client", input.client);
      const messages: Array<MachineToPortal> = [];
      if (Object.keys(server).length > 0) {
        messages.push({ _tag: "localSettings", scope: "server", values: server, shared: true });
      }
      if (Object.keys(client).length > 0) {
        messages.push({ _tag: "localSettings", scope: "client", values: client, shared: true });
      }
      if (messages.length === 0) return { shared: false };
      for (const message of messages) yield* send(message);
      return { shared: true };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Machine map could not share settings.", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({ shared: false })),
      ),
    );

  /**
   * MM-211: joins with the code that the installer left. The file goes first, so a bad or used
   * code does not repeat at each start.
   */
  const joinPendingCode = Effect.gen(function* () {
    const pendingPath = path.join(config.stateDir, PENDING_JOIN_FILE);
    if (!(yield* fileSystem.exists(pendingPath))) return;
    const code = (yield* fileSystem.readFileString(pendingPath)).trim();
    yield* fileSystem.remove(pendingPath);
    if (code.length === 0) return;
    yield* join({ code });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Machine map could not join with the code of the installer.", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  // --- Start ---------------------------------------------------------------------------------

  // MM-607: the saved desired state applies before the server accepts requests. The layer
  // builds before the HTTP routes serve, so this runs first.
  const atStart = yield* state.snapshot;
  if (atStart.enabled && atStart.saved.desired !== null) {
    yield* applyServerSettings(atStart.saved.desired.settings.server).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Machine map could not apply the saved desired state.", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  }
  yield* settings.getSettings.pipe(
    Effect.flatMap(reportedServerSettings),
    Effect.flatMap((baseline) => Ref.set(settingsBaseline, baseline)),
    Effect.ignore({ log: true }),
  );
  yield* forkParked(superviseConnection);
  yield* forkParked(watchLocalSettings);
  yield* forkParked(watchExpiries);
  // MM-1306: a revocation that failed runs again until it works.
  yield* forkParked(
    Effect.forever(
      revokePending.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Machine map could not end sessions; it tries again.", {
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(Effect.sleep(REVOKE_RETRY_INTERVAL)),
      ),
    ),
  );
  // MM-605: a desktop command that waited past its expiry never runs. The desktop app can stay
  // closed for days, so the server reports it as failed and drops it.
  yield* forkParked(
    Effect.forever(
      expireDesktopCommands.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Machine map could not expire desktop commands.", {
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(Effect.sleep(DESKTOP_COMMAND_EXPIRY_CHECK)),
      ),
    ),
  );
  yield* forkParked(watchClientAccess);
  // MM-906: browser keys that signed in and wait for approval. The outbox keeps them while offline.
  yield* forkParked(Effect.forever(Queue.take(state.clientSeen).pipe(Effect.flatMap(sendOrQueue))));
  yield* forkParked(statusLoop);
  yield* forkParked(joinPendingCode);

  return MachineMap.of({
    join,
    leave,
    clientStates,
    reportDesktop,
    callMapTool,
    readPanel,
    shareSettings,
  });
});

export const layer = Layer.effect(MachineMap, make);
