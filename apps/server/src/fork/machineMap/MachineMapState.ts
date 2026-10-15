/**
 * Fork: machine map (`apps/machine-map/SPEC.md`). The local state of this machine: the last
 * desired state (MM-1304), the machine token (MM-1302), and the two auth decisions that the
 * upstream auth hooks call (MM-1305, MM-1307), and the pause lock (MM-718). The `machineMap` setting gates both decisions,
 * so with the setting off, auth is unchanged (MM-1301).
 *
 * It depends on no auth service, because `EnvironmentAuth` reads it.
 */
import {
  type AuthMcpClientAccess,
  DEFAULT_MACHINE_MAP_PORTAL_URL,
  MachineCommand,
  MachineDesiredState,
  type MachineMapTokenHeaders,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  type MachineGrant,
  isLocalDesktopSubject,
  clientGrantFor,
  machineGrantFor,
  machineMcpAccessFor,
} from "./machineAccess.ts";

/** The secret store entry of the machine token. Never `settings.json` (MM-1302). */
const TOKEN_SECRET_NAME = "machine-map-token";
/** Enough to recognise a command the portal sends again after a reconnect or a restart. */
const HANDLED_COMMANDS_KEPT = 100;

export const MachineToken = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  secret: TrimmedNonEmptyString,
});
export type MachineToken = typeof MachineToken.Type;

export const tokenHeaders = (token: MachineToken): MachineMapTokenHeaders => ({
  "CF-Access-Client-Id": token.clientId,
  "CF-Access-Client-Secret": token.secret,
});

/** The file `<stateDir>/machine-map.json`. */
const SavedState = Schema.Struct({
  desired: Schema.NullOr(MachineDesiredState).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Commands this machine ran, newest last, so a command sent again does not run twice. */
  handledCommandIds: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Scheduled tasks that `pauseScheduledTasks` turned off. `resumeScheduledTasks` turns them on. */
  pausedTaskIds: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** MM-1402: desktop commands that wait for the desktop app, also across a server restart. */
  desktopCommands: Schema.Array(MachineCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type SavedState = typeof SavedState.Type;
const EMPTY_SAVED_STATE: SavedState = {
  desired: null,
  handledCommandIds: [],
  pausedTaskIds: [],
  desktopCommands: [],
};
const decodeSavedState = Schema.decodeUnknownEffect(fromLenientJson(SavedState));
const encodeSavedState = Schema.encodeEffect(fromJsonStringPretty(SavedState));
const decodeToken = Schema.decodeUnknownEffect(fromLenientJson(MachineToken));
const encodeToken = Schema.encodeEffect(Schema.fromJsonString(MachineToken));

export interface LocalState {
  /** The `machineMap` setting. */
  readonly enabled: boolean;
  readonly portalUrl: string;
  readonly token: MachineToken | null;
  readonly saved: SavedState;
}

export class MachineMapStateError extends Schema.TaggedError<MachineMapStateError>()(
  "MachineMapStateError",
  {
    operation: Schema.Literals(["write-state", "write-token", "remove-token"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Machine map could not ${this.operation.replace("-", " the ")}.`;
  }
}

export class MachineMapState extends Context.Service<
  MachineMapState,
  {
    readonly snapshot: Effect.Effect<LocalState>;
    /** The current state, then each change. */
    readonly changes: Stream.Stream<LocalState>;
    /** The desired state while the machine map is on; null when it is off or before the first. */
    readonly activeDesired: Effect.Effect<MachineDesiredState | null>;
    /**
     * MM-718: true while the pause locks the sessions of `subject`. The pause locks every subject
     * except the desktop app of this machine.
     */
    readonly lockedFor: (subject: string) => Effect.Effect<boolean>;
    /** MM-718: completes when the pause locks `subject`, at once when it is locked now. */
    readonly awaitLockFor: (subject: string) => Effect.Effect<void>;
    readonly updateSaved: (
      update: (saved: SavedState) => SavedState,
    ) => Effect.Effect<SavedState, MachineMapStateError>;
    readonly rememberCommand: (commandId: string) => Effect.Effect<void, MachineMapStateError>;
    readonly setToken: (token: MachineToken | null) => Effect.Effect<void, MachineMapStateError>;
    /**
     * MM-1311: true for the origin `https://<hostname>` of a peer in the desired state, while the
     * map is on. Sync, because the CORS and cookie checks of each request read it.
     */
    readonly trustsPeerOrigin: (origin: string) => boolean;
    /** MM-1311: the peer origins, sorted, for the server config of the clients. */
    readonly peerOrigins: () => ReadonlyArray<string>;
    /** MM-1305: the grant for a service token that is another machine with an arrow into this one. */
    readonly machineGrant: (tokenClientId: string) => Effect.Effect<MachineGrant | undefined>;
    /** MM-1307: the MCP client of a machine session whose arrow has agent tools. */
    readonly mcpClient: (session: {
      readonly sessionId: string;
      readonly subject: string;
      readonly method: string;
    }) => Effect.Effect<
      | { readonly sessionId: string; readonly label: string; readonly access: AuthMcpClientAccess }
      | undefined
    >;
  }
>()("t3/fork/machineMap/MachineMapState") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const statePath = path.join(config.stateDir, "machine-map.json");

  // A broken file or token must not stop the server. It starts empty and logs why. A broken
  // file can hide a pause, so the lock holds until the portal sends a desired state (MM-718).
  const { saved: savedOnDisk, unreadable: savedUnreadable } = yield* fileSystem
    .readFileString(statePath)
    .pipe(
      Effect.flatMap(decodeSavedState),
      Effect.map((saved) => ({ saved, unreadable: false })),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (!(yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false)))) {
            return { saved: EMPTY_SAVED_STATE, unreadable: false };
          }
          yield* Effect.logWarning("Machine map state file is unreadable; starting empty.", {
            path: statePath,
            cause: String(cause),
          });
          return { saved: EMPTY_SAVED_STATE, unreadable: true };
        }),
      ),
    );
  const tokenOnDisk = yield* secrets.get(TOKEN_SECRET_NAME).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(null),
        onSome: (bytes) => decodeToken(new TextDecoder().decode(bytes)),
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Machine map token is unreadable; join again.", {
        cause: String(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  // Settings that fail to load keep the machine map off: no connection and no auth change.
  const settingAtStart = yield* settings.getSettings.pipe(
    Effect.map((current) => current.machineMap),
    Effect.orElseSucceed(() => ({ enabled: false, portalUrl: DEFAULT_MACHINE_MAP_PORTAL_URL })),
  );
  const state = yield* SubscriptionRef.make<LocalState>({
    ...settingAtStart,
    token: tokenOnDisk,
    saved: savedOnDisk,
  });
  yield* settings.streamChanges.pipe(
    Stream.runForEach(({ machineMap }) =>
      SubscriptionRef.update(state, (local) =>
        local.enabled === machineMap.enabled && local.portalUrl === machineMap.portalUrl
          ? local
          : { ...local, enabled: machineMap.enabled, portalUrl: machineMap.portalUrl },
      ),
    ),
    Effect.forkScoped,
  );

  let peerOrigins: ReadonlySet<string> = new Set();
  yield* SubscriptionRef.changes(state).pipe(
    Stream.runForEach((local) =>
      Effect.sync(() => {
        peerOrigins = peerOriginsOf(local);
      }),
    ),
    Effect.forkScoped,
  );

  const writes = yield* Semaphore.make(1);

  const updateSaved: MachineMapState["Service"]["updateSaved"] = (update) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const next = update((yield* SubscriptionRef.get(state)).saved);
        yield* encodeSavedState(next).pipe(
          Effect.flatMap((contents) =>
            writeFileStringAtomically({ filePath: statePath, contents }),
          ),
          Effect.mapError((cause) => new MachineMapStateError({ operation: "write-state", cause })),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        yield* SubscriptionRef.update(state, (local) => ({ ...local, saved: next }));
        return next;
      }),
    );

  const setToken: MachineMapState["Service"]["setToken"] = (token) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        if (token === null) {
          yield* secrets
            .remove(TOKEN_SECRET_NAME)
            .pipe(
              Effect.mapError(
                (cause) => new MachineMapStateError({ operation: "remove-token", cause }),
              ),
            );
        } else {
          yield* encodeToken(token).pipe(
            Effect.flatMap((json) =>
              secrets.set(TOKEN_SECRET_NAME, new TextEncoder().encode(json)),
            ),
            Effect.mapError(
              (cause) => new MachineMapStateError({ operation: "write-token", cause }),
            ),
          );
        }
        yield* SubscriptionRef.update(state, (local) => ({ ...local, token }));
      }),
    );

  const activeDesired = SubscriptionRef.get(state).pipe(
    Effect.map((local) => (local.enabled ? local.saved.desired : null)),
  );

  // MM-718: only `paused: false` or an absent flag in a readable desired state unlocks.
  const isPaused = (local: LocalState) =>
    local.enabled &&
    (local.saved.desired === null ? savedUnreadable : local.saved.desired.paused === true);
  const lockedFor: MachineMapState["Service"]["lockedFor"] = (subject) =>
    isLocalDesktopSubject(subject)
      ? Effect.succeed(false)
      : SubscriptionRef.get(state).pipe(Effect.map(isPaused));
  const awaitLockFor: MachineMapState["Service"]["awaitLockFor"] = (subject) =>
    isLocalDesktopSubject(subject)
      ? Effect.never
      : SubscriptionRef.changes(state).pipe(Stream.filter(isPaused), Stream.runHead, Effect.asVoid);

  return MachineMapState.of({
    snapshot: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    activeDesired,
    lockedFor,
    awaitLockFor,
    updateSaved,
    rememberCommand: (commandId) =>
      updateSaved((saved) => ({
        ...saved,
        handledCommandIds: [
          ...saved.handledCommandIds.filter((id) => id !== commandId),
          commandId,
        ].slice(-HANDLED_COMMANDS_KEPT),
      })).pipe(Effect.asVoid),
    setToken,
    trustsPeerOrigin: (origin) => peerOrigins.has(origin),
    peerOrigins: () => [...peerOrigins].toSorted(),
    machineGrant: (tokenClientId) =>
      Effect.all([activeDesired, Clock.currentTimeMillis]).pipe(
        Effect.map(([desired, nowMs]) =>
          desired === null
            ? undefined
            : (machineGrantFor(desired, tokenClientId, nowMs) ??
              clientGrantFor(desired, tokenClientId, nowMs)),
        ),
      ),
    mcpClient: (session) =>
      Effect.all([activeDesired, Clock.currentTimeMillis]).pipe(
        Effect.map(([desired, nowMs]) => {
          // Only a bearer token, as an MCP client presents it. Never a cookie.
          if (desired === null || session.method !== "bearer-access-token") return undefined;
          const granted = machineMcpAccessFor(desired, session.subject, nowMs);
          return granted === undefined
            ? undefined
            : {
                sessionId: session.sessionId,
                label: `machine ${granted.peer.name}`,
                access: granted.access,
              };
        }),
      ),
  });
});

/** MM-1311: only a bare host becomes an origin, so a strange hostname never widens the trust. */
const peerOriginsOf = (local: LocalState): ReadonlySet<string> => {
  const desired = local.enabled ? local.saved.desired : null;
  if (desired === null) return new Set();
  return new Set(
    desired.peers.flatMap((peer) => {
      if (peer.hostname === null) return [];
      const url = URL.parse(`https://${peer.hostname}`);
      return url !== null && url.host === peer.hostname.toLowerCase() ? [url.origin] : [];
    }),
  );
};

export const layer = Layer.effect(MachineMapState, make);
