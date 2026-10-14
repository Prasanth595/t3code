/**
 * Fork: machine map. The tunnel that a join delivers (MM-213, MM-1309, MM-1310).
 *
 * - The join saves the tunnel token in the server secret store and the hostname and the Access
 *   login in `<stateDir>/machine-map-tunnel.json`.
 * - At start, `cli/config.ts` reads that file for the tunnel and Access settings, unless the
 *   environment or the desktop settings give their own tunnel. Then the explicit values win.
 * - When the server uses the joined tunnel, this service runs `cloudflared` as a child process
 *   from `<stateDir>/bin`. It starts it again after each exit and stops it with the server.
 */
import { MachineMapRequestError, MachineTunnelGrant } from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";

const JOINED_TUNNEL_FILE = "machine-map-tunnel.json";
const TOKEN_SECRET_NAME = "machine-map-tunnel-token";
/** A pause after each exit, so a broken token or download does not spin. */
const RESTART_DELAY = Duration.seconds(10);
const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

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

/** The official `cloudflared` release asset of this platform. Null where Cloudflare has none. */
function cloudflaredAsset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): { readonly name: string; readonly archive: boolean } | null {
  const plain = (name: string) => ({ name, archive: false });
  if (platform === "linux") {
    if (arch === "x64") return plain("cloudflared-linux-amd64");
    if (arch === "arm64") return plain("cloudflared-linux-arm64");
    if (arch === "arm") return plain("cloudflared-linux-arm");
    if (arch === "ia32") return plain("cloudflared-linux-386");
  }
  if (platform === "darwin") {
    if (arch === "x64") return { name: "cloudflared-darwin-amd64.tgz", archive: true };
    if (arch === "arm64") return { name: "cloudflared-darwin-arm64.tgz", archive: true };
  }
  if (platform === "win32") {
    // Windows on Arm runs the amd64 build through emulation; Cloudflare ships no arm64 build.
    if (arch === "x64" || arch === "arm64") return plain("cloudflared-windows-amd64.exe");
    if (arch === "ia32") return plain("cloudflared-windows-386.exe");
  }
  return null;
}

/** `cloudflared` could not download, unpack or start. The supervisor tries again. */
export class CloudflaredError extends Schema.TaggedError<CloudflaredError>()("CloudflaredError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

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
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const filePath = path.join(config.stateDir, JOINED_TUNNEL_FILE);
  const binDir = path.join(config.stateDir, "bin");
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

  /** Downloads the official binary once. A later start uses it, and `cloudflared` updates itself. */
  const ensureBinary = Effect.gen(function* () {
    const asset = cloudflaredAsset(platform, arch);
    if (asset === null) {
      return yield* new CloudflaredError({
        detail: `Cloudflare has no cloudflared build for ${platform} ${arch}.`,
      });
    }
    const binary = path.join(binDir, platform === "win32" ? "cloudflared.exe" : "cloudflared");
    if (yield* fileSystem.exists(binary)) return binary;
    yield* fileSystem.makeDirectory(binDir, { recursive: true });
    // Limit: HTTPS from GitHub is the only check. Cloudflare publishes the checksums only in the
    // release text. Revisit when the release adds a machine-readable checksum file.
    const download = path.join(binDir, `${asset.name}.download`);
    const bytes = yield* httpClient
      .execute(HttpClientRequest.get(`${RELEASES}/${asset.name}`))
      .pipe(Effect.flatMap((response) => response.arrayBuffer));
    yield* fileSystem.writeFile(download, new Uint8Array(bytes));
    if (asset.archive) {
      // The macOS archive holds one file, `cloudflared`.
      const untar = yield* processRunner.run({
        command: "tar",
        args: ["-xzf", download, "-C", binDir],
        timeout: Duration.minutes(1),
      });
      yield* fileSystem.remove(download);
      if (untar.code !== 0) {
        return yield* new CloudflaredError({ detail: "Could not unpack cloudflared." });
      }
    } else {
      yield* fileSystem.rename(download, binary);
    }
    yield* fileSystem.chmod(binary, 0o755);
    yield* Effect.logInfo("Downloaded cloudflared.", { path: binary });
    return binary;
  });

  const runOnce = (token: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const binary = yield* ensureBinary;
        // The token goes in the environment, so it does not show in the process list.
        const child = yield* spawner.spawn(
          ChildProcess.make(
            binary,
            [
              "tunnel",
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
  const token = yield* readToken.pipe(Effect.orElseSucceed(() => null));
  if (
    joined !== undefined &&
    token !== null &&
    config.tunnelPairingUrl === joinedTunnelOrigin(joined)
  ) {
    yield* runOnce(token).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("cloudflared could not run. It tries again.", { cause: String(cause) }),
      ),
      Effect.andThen(Effect.sleep(RESTART_DELAY)),
      Effect.forever,
      Effect.forkScoped,
    );
  }

  const adopt: MachineTunnel["Service"]["adopt"] = (grant) =>
    Effect.gen(function* () {
      const saved = yield* provide(readJoinedTunnel(config.stateDir));
      const usesSaved =
        saved !== undefined && config.tunnelPairingUrl === joinedTunnelOrigin(saved);
      if (config.tunnelPairingUrl !== undefined && !usesSaved) {
        yield* Effect.logInfo("Machine map join keeps the tunnel of this server.", {
          tunnel: config.tunnelPairingUrl,
        });
        return "kept-own-tunnel" as const;
      }
      const next: JoinedTunnel = { hostname: grant.hostname, access: grant.access };
      const contents = yield* encodeJoinedTunnel(next);
      const savedToken = yield* readToken;
      const unchanged =
        usesSaved && savedToken === grant.token && contents === (yield* encodeJoinedTunnel(saved));
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
