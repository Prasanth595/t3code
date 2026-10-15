/**
 * Fork: machine map. The tunnel that a join delivers (MM-213, MM-1309, MM-1310).
 *
 * - The join saves the tunnel token in the server secret store and the hostname and the Access
 *   login in `<stateDir>/machine-map-tunnel.json`.
 * - At start, `cli/config.ts` reads that file for the tunnel and Access settings, unless the
 *   environment or the desktop settings give their own tunnel. Then the explicit values win.
 * - The joined tunnel applies only while the `machineMap` setting is on (MM-1301).
 * - When the server uses the joined tunnel, this service runs the pinned `cloudflared` of the
 *   upstream relay client as a child process. It starts it again after each exit, and stops it
 *   when the map turns off, on "Leave" too, or with the server.
 */
import { MachineMapRequestError, MachineTunnelGrant } from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";

const JOINED_TUNNEL_FILE = "machine-map-tunnel.json";
const TOKEN_SECRET_NAME = "machine-map-tunnel-token";
/** A pause after each exit, so a broken token or download does not spin. */
const RESTART_DELAY = Duration.seconds(10);

/** The grant without its token: the part that the config reads at start. */
export const JoinedTunnel = Schema.Struct({
  hostname: MachineTunnelGrant.fields.hostname,
  access: MachineTunnelGrant.fields.access,
});
export type JoinedTunnel = typeof JoinedTunnel.Type;
const decodeJoinedTunnel = Schema.decodeUnknownEffect(fromLenientJson(JoinedTunnel));
const encodeJoinedTunnel = Schema.encodeEffect(fromJsonStringPretty(JoinedTunnel));

export const joinedTunnelOrigin = (joined: JoinedTunnel): string => `https://${joined.hostname}`;

/**
 * The joined tunnel, or undefined without one. A file that does not decode logs a warning and
 * counts as no tunnel, so it never stops the server.
 */
export const readJoinedTunnel = (stateDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(stateDir, JOINED_TUNNEL_FILE);
    if (!(yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false)))) {
      return undefined;
    }
    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodeJoinedTunnel),
      Effect.catch((cause) =>
        Effect.logWarning("Machine map tunnel file is unreadable; join again.", {
          path: filePath,
          cause: String(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
  });

const MachineMapEnabled = Schema.Struct({
  machineMap: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
});
const decodeMachineMapEnabled = Schema.decodeUnknownEffect(fromLenientJson(MachineMapEnabled));

/**
 * MM-1301: whether `settings.json` turns the machine map on. The config reads it at start, before
 * the settings service runs. A missing or unreadable file counts as off, like the default.
 */
export const machineMapEnabledInSettings = (settingsPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(settingsPath).pipe(
      Effect.flatMap(decodeMachineMapEnabled),
      Effect.map((settings) => settings.machineMap?.enabled === true),
      Effect.orElseSucceed(() => false),
    );
  });

/** What `adopt` did with the tunnel of a join. */
export type AdoptResult =
  /** The server needs a restart to use the saved tunnel. */
  | "restart"
  /** The tunnel was saved already, with the same values. */
  | "unchanged"
  /** The server has its own tunnel from the environment or the desktop settings (MM-1310). */
  | "kept-own-tunnel";

export class MachineTunnel extends Context.Service<
  MachineTunnel,
  {
    /** Saves the tunnel of a join. The token never reaches a log or `settings.json`. */
    readonly adopt: (
      grant: MachineTunnelGrant,
    ) => Effect.Effect<AdoptResult, MachineMapRequestError>;
    /** Forgets the joined tunnel. The server stops using it at the next start. */
    readonly forget: Effect.Effect<void, MachineMapRequestError>;
  }
>()("t3/fork/machineMap/MachineTunnel") {}

const storageFailed = () =>
  new MachineMapRequestError({
    reason: "storage-failed",
    detail: "Could not save or remove the machine map tunnel.",
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const settings = yield* ServerSettings.ServerSettingsService;

  const filePath = path.join(config.stateDir, JOINED_TUNNEL_FILE);
  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const readToken = secrets
    .get(TOKEN_SECRET_NAME)
    .pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.map(Option.getOrNull),
    );

  const runOnce = Effect.scoped(
    Effect.gen(function* () {
      // Read on each start: "Leave" deletes the token, and a new join saves another one.
      const token = yield* readToken;
      if (token === null) {
        yield* Effect.logWarning("The machine map tunnel has no token. Join the map again.");
        return;
      }
      // The pinned release of the upstream relay client, with its sha256 checked.
      const binary = (yield* relayClient.install).executablePath;
      // The token goes in the environment, so it does not show in the process list.
      const child = yield* spawner.spawn(
        ChildProcess.make(
          binary,
          [
            "tunnel",
            // The relay client pins and checks this binary, and T3 Connect shares it.
            "--no-autoupdate",
            "--loglevel",
            "warn",
            "--logfile",
            path.join(config.logsDir, "cloudflared.log"),
            "run",
          ],
          {
            env: { TUNNEL_TOKEN: token },
            extendEnv: true,
            detached: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      );
      yield* Effect.logInfo("cloudflared started.", { pid: child.pid });
      const exitCode = yield* child.exitCode;
      yield* Effect.logWarning("cloudflared exited. It starts again.", {
        exitCode: Number(exitCode),
      });
    }),
  );

  // MM-1309: run `cloudflared` only when the server uses the joined tunnel. A tunnel from the
  // environment or the desktop settings has its own `cloudflared` (MM-1310).
  const joined = yield* provide(readJoinedTunnel(config.stateDir));
  // The config took its tunnel from the joined file at start, not from the environment.
  const startedWithJoined =
    joined !== undefined && config.tunnelPairingUrl === joinedTunnelOrigin(joined);
  if (startedWithJoined) {
    const runForever = runOnce.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("cloudflared could not run. It tries again.", { cause: String(cause) }),
      ),
      Effect.andThen(Effect.sleep(RESTART_DELAY)),
      Effect.forever,
    );
    // MM-1301: the tunnel follows the `machineMap` setting. Turning the map off, also by "Leave",
    // stops `cloudflared`, and turning it on starts it again.
    yield* Stream.concat(Stream.fromEffect(settings.getSettings), settings.streamChanges).pipe(
      Stream.map((current) => current.machineMap.enabled),
      Stream.changes,
      Stream.switchMap((enabled) => (enabled ? Stream.fromEffect(runForever) : Stream.empty)),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logWarning("The machine map tunnel stopped.", { cause: String(cause) }),
      ),
      Effect.forkScoped,
    );
  }

  const adopt: MachineTunnel["Service"]["adopt"] = (grant) =>
    Effect.gen(function* () {
      const saved = yield* provide(readJoinedTunnel(config.stateDir));
      // MM-1310: only a tunnel from the environment or the desktop settings is the server's own.
      // A tunnel from an earlier join stays the map's, also after "Leave" deleted its file.
      if (config.tunnelPairingUrl !== undefined && !startedWithJoined) {
        yield* Effect.logInfo("Machine map join keeps the tunnel of this server.", {
          tunnel: config.tunnelPairingUrl,
        });
        return "kept-own-tunnel" as const;
      }
      const next: JoinedTunnel = { hostname: grant.hostname, access: grant.access };
      const contents = yield* encodeJoinedTunnel(next);
      const savedToken = yield* readToken;
      const unchanged =
        saved !== undefined &&
        config.tunnelPairingUrl === joinedTunnelOrigin(saved) &&
        savedToken === grant.token &&
        contents === (yield* encodeJoinedTunnel(saved));
      if (unchanged) return "unchanged" as const;
      yield* secrets.set(TOKEN_SECRET_NAME, new TextEncoder().encode(grant.token));
      yield* provide(writeFileStringAtomically({ filePath, contents }));
      yield* Effect.logInfo("Machine map tunnel saved. The server uses it after a restart.", {
        hostname: grant.hostname,
      });
      return "restart" as const;
    }).pipe(Effect.mapError(storageFailed));

  const forget: MachineTunnel["Service"]["forget"] = Effect.gen(function* () {
    yield* secrets.remove(TOKEN_SECRET_NAME);
    if (yield* fileSystem.exists(filePath)) yield* fileSystem.remove(filePath);
  }).pipe(Effect.mapError(storageFailed));

  return MachineTunnel.of({ adopt, forget });
});

export const layer = Layer.effect(MachineTunnel, make);
