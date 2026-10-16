import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@t3tools/shared/advertisedEndpoint";
import {
  DesktopServerExposureModeSchema,
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
} from "@t3tools/contracts";
import { isTailscaleIpv4Address, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const TAILSCALE_STATUS_CACHE_TTL = Duration.seconds(60);

const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST = "0.0.0.0";

interface ResolvedDesktopServerExposure {
  readonly mode: DesktopServerExposureMode;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly endpointUrl: string | null;
  readonly advertisedHost: string | null;
}

interface DesktopAdvertisedEndpointInput {
  readonly port: number;
  readonly exposure: ResolvedDesktopServerExposure;
  readonly customHttpsEndpointUrls?: readonly string[];
  // Fork: the active tunnel pairing URL.
  readonly tunnelPairingUrl?: string;
}

const DESKTOP_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

const DESKTOP_MANUAL_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "manual",
  label: "Manual",
  kind: "manual",
  isAddon: false,
};

const normalizeOptionalHost = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const isUsableLanIpv4Address = (address: string): boolean =>
  !address.startsWith("127.") &&
  !address.startsWith("169.254.") &&
  !isTailscaleIpv4Address(address);

const isHttpsEndpointUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const resolveLanAdvertisedHost = (
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  explicitHost: string | undefined,
): string | null => {
  const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
  if (normalizedExplicitHost) {
    return normalizedExplicitHost;
  }

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isUsableLanIpv4Address(address.address)) continue;
      return address.address;
    }
  }

  return null;
};

const resolveDesktopServerExposure = (input: {
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly advertisedHostOverride?: string;
}): ResolvedDesktopServerExposure => {
  const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
  const localWsUrl = `ws://${DESKTOP_LOOPBACK_HOST}:${input.port}`;

  if (input.mode === "local-only") {
    return {
      mode: input.mode,
      bindHost: DESKTOP_LOOPBACK_HOST,
      localHttpUrl,
      localWsUrl,
      endpointUrl: null,
      advertisedHost: null,
    };
  }

  const advertisedHost = resolveLanAdvertisedHost(
    input.networkInterfaces,
    input.advertisedHostOverride,
  );

  return {
    mode: input.mode,
    bindHost: DESKTOP_LAN_BIND_HOST,
    localHttpUrl,
    localWsUrl,
    endpointUrl: advertisedHost ? `http://${advertisedHost}:${input.port}` : null,
    advertisedHost,
  };
};

const createDesktopEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_CORE_ENDPOINT_PROVIDER,
    source: "desktop-core",
  });

const createManualEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_MANUAL_ENDPOINT_PROVIDER,
    source: "user",
  });

const TUNNEL_ENDPOINT_ID_PREFIX = "tunnel:";

const resolveDesktopCoreAdvertisedEndpoints = (
  input: DesktopAdvertisedEndpointInput,
): readonly AdvertisedEndpoint[] => {
  const endpoints: AdvertisedEndpoint[] = [
    createDesktopEndpoint({
      id: `desktop-loopback:${input.port}`,
      label: "This machine",
      httpBaseUrl: input.exposure.localHttpUrl,
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this desktop app.",
    }),
  ];

  if (input.exposure.endpointUrl) {
    endpoints.push(
      createDesktopEndpoint({
        id: `desktop-lan:${input.exposure.endpointUrl}`,
        label: "Local network",
        httpBaseUrl: input.exposure.endpointUrl,
        reachability: "lan",
        status: "available",
        isDefault: true,
        description: "Reachable from devices on the same network.",
      }),
    );
  }

  // Fork: the tunnel serves this server's own web app, so pairing links point
  // at it directly (not at the hosted app) and it is the default choice.
  if (input.tunnelPairingUrl !== undefined) {
    endpoints.push(
      createManualEndpoint({
        id: `${TUNNEL_ENDPOINT_ID_PREFIX}${input.tunnelPairingUrl}`,
        label: "Tunnel",
        httpBaseUrl: input.tunnelPairingUrl,
        reachability: "public",
        status: "unknown",
        isDefault: true,
        description: "Tunnel to this desktop backend.",
      }),
    );
  }

  for (const customEndpointUrl of input.customHttpsEndpointUrls ?? []) {
    try {
      const isHttpsEndpoint = isHttpsEndpointUrl(customEndpointUrl);
      endpoints.push(
        createManualEndpoint({
          id: `manual:${customEndpointUrl}`,
          label: isHttpsEndpoint ? "Custom HTTPS" : "Custom endpoint",
          httpBaseUrl: customEndpointUrl,
          reachability: "public",
          ...(isHttpsEndpoint ? ({ hostedHttpsCompatibility: "compatible" } as const) : {}),
          status: "unknown",
          description: isHttpsEndpoint
            ? "User-configured HTTPS endpoint for this desktop backend."
            : "User-configured endpoint for this desktop backend.",
        }),
      );
    } catch {}
  }

  return endpoints;
};

export class DesktopServerExposureNoNetworkAddressError extends Schema.TaggedError<DesktopServerExposureNoNetworkAddressError>()(
  "DesktopServerExposureNoNetworkAddressError",
  {
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `No reachable network address is available for desktop network access on port ${this.port}.`;
  }
}

export class DesktopServerExposureModePersistenceError extends Schema.TaggedError<DesktopServerExposureModePersistenceError>()(
  "DesktopServerExposureModePersistenceError",
  {
    mode: DesktopServerExposureModeSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop server exposure mode ${this.mode}.`;
  }
}

export class DesktopTailscaleServePersistenceError extends Schema.TaggedError<DesktopTailscaleServePersistenceError>()(
  "DesktopTailscaleServePersistenceError",
  {
    enabled: Schema.Boolean,
    port: Schema.NullOr(Schema.Number),
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop Tailscale Serve settings (enabled: ${this.enabled}, port: ${this.port ?? "unchanged"}).`;
  }
}

export class DesktopTunnelPairingInvalidUrlError extends Schema.TaggedError<DesktopTunnelPairingInvalidUrlError>()(
  "DesktopTunnelPairingInvalidUrlError",
  { url: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return `Tunnel pairing needs an https origin such as https://t3.example.com, got ${this.url ?? "nothing"}.`;
  }
}

export class DesktopTunnelPairingPersistenceError extends Schema.TaggedError<DesktopTunnelPairingPersistenceError>()(
  "DesktopTunnelPairingPersistenceError",
  {
    enabled: Schema.Boolean,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop tunnel pairing settings (enabled: ${this.enabled}).`;
  }
}

export const DesktopTunnelPairingError = Schema.Union([
  DesktopTunnelPairingInvalidUrlError,
  DesktopTunnelPairingPersistenceError,
]);
export type DesktopTunnelPairingError = typeof DesktopTunnelPairingError.Type;

export const TunnelPairingInput = Schema.Struct({
  enabled: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  // Fork: comma or newline separated https origins; null or blank clears them.
  trustedBrowserOrigins: Schema.NullOr(Schema.String),
  // Fork: Cloudflare Access login; null or blank clears a value.
  cloudflareAccessTeamDomain: Schema.NullOr(Schema.String),
  cloudflareAccessAud: Schema.NullOr(Schema.String),
  cloudflareAccessSubjects: Schema.NullOr(Schema.String),
});

export const DesktopServerExposureSetModeError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
]);
export type DesktopServerExposureSetModeError = typeof DesktopServerExposureSetModeError.Type;

export const DesktopServerExposureError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
  DesktopTailscaleServePersistenceError,
  DesktopTunnelPairingInvalidUrlError,
  DesktopTunnelPairingPersistenceError,
]);
export type DesktopServerExposureError = typeof DesktopServerExposureError.Type;

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  // Fork: set only while tunnel pairing is on.
  readonly tunnelPairingUrl: Option.Option<string>;
  readonly trustedBrowserOrigins: Option.Option<string>;
  readonly cloudflareAccess: Option.Option<{
    readonly teamDomain: string;
    readonly aud: string;
    readonly subjects: string;
  }>;
}

export interface DesktopServerExposureChange {
  readonly state: DesktopServerExposureState;
  readonly requiresRelaunch: boolean;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly getState: Effect.Effect<DesktopServerExposureState>;
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    readonly setMode: (
      mode: DesktopServerExposureMode,
    ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
    readonly setTailscaleServeEnabled: (input: {
      readonly enabled: boolean;
      readonly port?: number;
    }) => Effect.Effect<DesktopServerExposureChange, DesktopTailscaleServePersistenceError>;
    readonly setTunnelPairing: (
      input: typeof TunnelPairingInput.Type,
    ) => Effect.Effect<DesktopServerExposureChange, DesktopTunnelPairingError>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@t3tools/desktop/backend/DesktopServerExposure") {}

interface RuntimeState {
  readonly requestedMode: DesktopServerExposureMode;
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly httpBaseUrl: URL;
  readonly endpointUrl: Option.Option<string>;
  readonly advertisedHost: Option.Option<string>;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly tunnelPairingEnabled: boolean;
  readonly tunnelPairingUrl: Option.Option<string>;
  readonly trustedBrowserOrigins: Option.Option<string>;
  readonly cloudflareAccess: DesktopAppSettings.CloudflareAccessSettings;
}

interface ResolvedRuntimeState {
  readonly state: RuntimeState;
  readonly unavailable: boolean;
}

const initialRuntimeState = (): RuntimeState =>
  runtimeStateFromResolvedExposure({
    requestedMode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
    settings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    exposure: resolveDesktopServerExposure({
      mode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
      port: 0,
      networkInterfaces: {},
    }),
    port: 0,
  });

const toContractState = (state: RuntimeState): DesktopServerExposureState => ({
  mode: state.mode,
  endpointUrl: Option.getOrNull(state.endpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
  tailscaleServeEnabled: state.tailscaleServeEnabled,
  tailscaleServePort: state.tailscaleServePort,
  tunnelPairingEnabled: state.tunnelPairingEnabled,
  tunnelPairingUrl: Option.getOrNull(state.tunnelPairingUrl),
  trustedBrowserOrigins: Option.getOrNull(state.trustedBrowserOrigins),
  ...state.cloudflareAccess,
});

// Fork: the tunnel URL reaches the backend and the endpoint list only while
// tunnel pairing is on.
const activeTunnelPairingUrl = (state: RuntimeState): Option.Option<string> =>
  state.tunnelPairingEnabled ? state.tunnelPairingUrl : Option.none();
const activeTrustedBrowserOrigins = (state: RuntimeState): Option.Option<string> =>
  state.tunnelPairingEnabled ? state.trustedBrowserOrigins : Option.none();
// The server fails startup on a partial set, so only a full set reaches it.
const activeCloudflareAccess = (
  state: RuntimeState,
): DesktopServerExposureBackendConfig["cloudflareAccess"] => {
  const { cloudflareAccessTeamDomain, cloudflareAccessAud, cloudflareAccessSubjects } =
    state.cloudflareAccess;
  return state.tunnelPairingEnabled &&
    cloudflareAccessTeamDomain !== null &&
    cloudflareAccessAud !== null &&
    cloudflareAccessSubjects !== null
    ? Option.some({
        teamDomain: cloudflareAccessTeamDomain,
        aud: cloudflareAccessAud,
        subjects: cloudflareAccessSubjects,
      })
    : Option.none();
};
const sameCloudflareAccess = (previous: RuntimeState, next: RuntimeState) => {
  const left = Option.getOrNull(activeCloudflareAccess(previous));
  const right = Option.getOrNull(activeCloudflareAccess(next));
  return (
    left?.teamDomain === right?.teamDomain &&
    left?.aud === right?.aud &&
    left?.subjects === right?.subjects
  );
};

const toBackendConfig = (state: RuntimeState): DesktopServerExposureBackendConfig => ({
  port: state.port,
  bindHost: state.bindHost,
  httpBaseUrl: state.httpBaseUrl,
  tailscaleServeEnabled: state.tailscaleServeEnabled,
  tailscaleServePort: state.tailscaleServePort,
  tunnelPairingUrl: activeTunnelPairingUrl(state),
  trustedBrowserOrigins: activeTrustedBrowserOrigins(state),
  cloudflareAccess: activeCloudflareAccess(state),
});

const toResolvedExposure = (state: RuntimeState): ResolvedDesktopServerExposure => ({
  mode: state.mode,
  bindHost: state.bindHost,
  localHttpUrl: state.localHttpUrl,
  localWsUrl: state.localWsUrl,
  endpointUrl: Option.getOrNull(state.endpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
});

function runtimeStateFromResolvedExposure(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopAppSettings.DesktopSettings;
  readonly exposure: ResolvedDesktopServerExposure;
  readonly port: number;
}): RuntimeState {
  return {
    requestedMode: input.requestedMode,
    mode: input.exposure.mode,
    port: input.port,
    bindHost: input.exposure.bindHost,
    localHttpUrl: input.exposure.localHttpUrl,
    localWsUrl: input.exposure.localWsUrl,
    httpBaseUrl: new URL(input.exposure.localHttpUrl),
    endpointUrl: Option.fromNullishOr(input.exposure.endpointUrl),
    advertisedHost: Option.fromNullishOr(input.exposure.advertisedHost),
    tailscaleServeEnabled: input.settings.tailscaleServeEnabled,
    tailscaleServePort: input.settings.tailscaleServePort,
    tunnelPairingEnabled: input.settings.tunnelPairingEnabled,
    tunnelPairingUrl: Option.fromNullishOr(input.settings.tunnelPairingUrl),
    trustedBrowserOrigins: Option.fromNullishOr(input.settings.trustedBrowserOrigins),
    cloudflareAccess: {
      cloudflareAccessTeamDomain: input.settings.cloudflareAccessTeamDomain,
      cloudflareAccessAud: input.settings.cloudflareAccessAud,
      cloudflareAccessSubjects: input.settings.cloudflareAccessSubjects,
    },
  };
}

function resolveRuntimeState(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopAppSettings.DesktopSettings;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly advertisedHostOverride: Option.Option<string>;
}): ResolvedRuntimeState {
  const advertisedHostOverride = Option.getOrUndefined(input.advertisedHostOverride);
  const requestedExposure = resolveDesktopServerExposure({
    mode: input.requestedMode,
    port: input.port,
    networkInterfaces: input.networkInterfaces,
    ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
  });
  const unavailable =
    input.requestedMode === "network-accessible" &&
    requestedExposure.endpointUrl === null &&
    !Object.values(input.networkInterfaces).some((addresses) =>
      addresses?.some(
        (address) =>
          !address.internal && address.family === "IPv4" && isTailscaleIpv4Address(address.address),
      ),
    );
  const exposure = unavailable
    ? resolveDesktopServerExposure({
        mode: "local-only",
        port: input.port,
        networkInterfaces: input.networkInterfaces,
        ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
      })
    : requestedExposure;

  return {
    state: runtimeStateFromResolvedExposure({
      requestedMode: input.requestedMode,
      settings: input.settings,
      exposure,
      port: input.port,
    }),
    unavailable,
  };
}

const requiresBackendRelaunch = (previous: RuntimeState, next: RuntimeState): boolean =>
  previous.port !== next.port ||
  previous.bindHost !== next.bindHost ||
  previous.localHttpUrl !== next.localHttpUrl;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const stateRef = yield* Ref.make(initialRuntimeState());
  // Each change reads the runtime state, persists settings, then writes the
  // state back. Run them one at a time so a change never writes over another
  // with values it read before that change persisted.
  const changePermit = yield* Semaphore.make(1);

  // Cache the `tailscale status` spawn for the TTL. On macOS, the Mac App
  // Store Tailscale CLI lives inside Tailscale's sandbox container, so each
  // spawn re-triggers the "Other apps" TCC prompt.
  const cachedReadMagicDnsName = yield* Effect.cachedWithTTL(
    readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ),
    TAILSCALE_STATUS_CACHE_TTL,
  );

  const readNetworkInterfaces = networkInterfaces.read;

  const getState = Ref.get(stateRef).pipe(Effect.map(toContractState));
  const backendConfig = Ref.get(stateRef).pipe(Effect.map(toBackendConfig));

  const configureFromSettings = Effect.fn("desktop.serverExposure.configureFromSettings")(
    function* ({ port }: { readonly port: number }) {
      yield* Effect.annotateCurrentSpan({ port });
      const settings = yield* desktopSettings.get;
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      const resolved = resolveRuntimeState({
        requestedMode: settings.serverExposureMode,
        settings,
        port,
        networkInterfaces: currentNetworkInterfaces,
        advertisedHostOverride: config.desktopLanHostOverride,
      });
      yield* Ref.set(stateRef, resolved.state);
      return toContractState(resolved.state);
    },
  );

  const setMode = Effect.fn("desktop.serverExposure.setMode")(function* (
    mode: DesktopServerExposureMode,
  ) {
    yield* Effect.annotateCurrentSpan({ mode });
    const previous = yield* Ref.get(stateRef);
    const currentSettings = yield* desktopSettings.get;
    const nextSettings = {
      ...currentSettings,
      serverExposureMode: mode,
    };
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const resolved = resolveRuntimeState({
      requestedMode: mode,
      settings: nextSettings,
      port: previous.port,
      networkInterfaces: currentNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });

    if (resolved.unavailable) {
      return yield* new DesktopServerExposureNoNetworkAddressError({ port: previous.port });
    }

    const change = yield* desktopSettings.setServerExposureMode(mode).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopServerExposureModePersistenceError({
            mode,
            cause,
          }),
      ),
    );

    yield* Ref.set(stateRef, resolved.state);
    return {
      state: toContractState(resolved.state),
      requiresRelaunch: change.changed || requiresBackendRelaunch(previous, resolved.state),
    };
  }, changePermit.withPermit);

  const setTailscaleServeEnabled = Effect.fn("desktop.serverExposure.setTailscaleServeEnabled")(
    function* (input: { readonly enabled: boolean; readonly port?: number }) {
      yield* Effect.annotateCurrentSpan({
        enabled: input.enabled,
        ...(input.port === undefined ? {} : { port: input.port }),
      });
      const result = yield* desktopSettings
        .setTailscaleServe({
          enabled: input.enabled,
          port: Option.fromNullishOr(input.port),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTailscaleServePersistenceError({
                enabled: input.enabled,
                port: input.port ?? null,
                cause,
              }),
          ),
        );

      const nextState = yield* Ref.updateAndGet(stateRef, (current) => ({
        ...current,
        tailscaleServeEnabled: result.settings.tailscaleServeEnabled,
        tailscaleServePort: result.settings.tailscaleServePort,
      }));

      return {
        state: toContractState(nextState),
        requiresRelaunch: result.changed,
      };
    },
    changePermit.withPermit,
  );

  const setTunnelPairing = Effect.fn("desktop.serverExposure.setTunnelPairing")(function* (
    input: typeof TunnelPairingInput.Type,
  ) {
    yield* Effect.annotateCurrentSpan({ enabled: input.enabled });
    const url = input.url === null ? null : DesktopAppSettings.normalizeTunnelPairingUrl(input.url);
    // An invalid URL is rejected, never stored. Turning pairing off with no
    // URL is fine; a blank URL clears the stored one.
    if (
      (input.url !== null && input.url.trim().length > 0 && url === null) ||
      (input.enabled && url === null)
    ) {
      return yield* new DesktopTunnelPairingInvalidUrlError({ url: input.url });
    }
    const trustedBrowserOrigins = DesktopAppSettings.normalizeTrustedBrowserOrigins(
      input.trustedBrowserOrigins,
    );
    if (trustedBrowserOrigins === undefined) {
      return yield* new DesktopTunnelPairingInvalidUrlError({ url: input.trustedBrowserOrigins });
    }
    const cloudflareAccessTeamDomain = DesktopAppSettings.normalizeCloudflareAccessTeamDomain(
      input.cloudflareAccessTeamDomain,
    );
    if (
      cloudflareAccessTeamDomain === null &&
      DesktopAppSettings.normalizeSettingText(input.cloudflareAccessTeamDomain) !== null
    ) {
      return yield* new DesktopTunnelPairingInvalidUrlError({
        url: input.cloudflareAccessTeamDomain,
      });
    }
    const cloudflareAccess = {
      cloudflareAccessTeamDomain,
      cloudflareAccessAud: DesktopAppSettings.normalizeSettingText(input.cloudflareAccessAud),
      cloudflareAccessSubjects: DesktopAppSettings.normalizeSettingText(
        input.cloudflareAccessSubjects,
      ),
    };
    const result = yield* desktopSettings
      .setTunnelPairing({ enabled: input.enabled, url, trustedBrowserOrigins, cloudflareAccess })
      .pipe(
        Effect.mapError(
          (cause) => new DesktopTunnelPairingPersistenceError({ enabled: input.enabled, cause }),
        ),
      );
    const previous = yield* Ref.get(stateRef);
    const nextState = yield* Ref.updateAndGet(stateRef, (current) => ({
      ...current,
      tunnelPairingEnabled: result.settings.tunnelPairingEnabled,
      tunnelPairingUrl: Option.fromNullishOr(result.settings.tunnelPairingUrl),
      trustedBrowserOrigins: Option.fromNullishOr(result.settings.trustedBrowserOrigins),
      cloudflareAccess: {
        cloudflareAccessTeamDomain: result.settings.cloudflareAccessTeamDomain,
        cloudflareAccessAud: result.settings.cloudflareAccessAud,
        cloudflareAccessSubjects: result.settings.cloudflareAccessSubjects,
      },
    }));
    return {
      state: toContractState(nextState),
      // The backend reads these only at start, so restart when they change.
      requiresRelaunch:
        Option.getOrNull(activeTunnelPairingUrl(previous)) !==
          Option.getOrNull(activeTunnelPairingUrl(nextState)) ||
        Option.getOrNull(activeTrustedBrowserOrigins(previous)) !==
          Option.getOrNull(activeTrustedBrowserOrigins(nextState)) ||
        !sameCloudflareAccess(previous, nextState),
    };
  }, changePermit.withPermit);

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      exposure: toResolvedExposure(state),
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
      ...Option.match(activeTunnelPairingUrl(state), {
        onNone: () => ({}),
        onSome: (tunnelPairingUrl) => ({ tunnelPairingUrl }),
      }),
    });

    // Don't spawn the Tailscale CLI when the user hasn't opted into any
    // network exposure. The spawn itself triggers a macOS "Other apps"
    // TCC prompt on Mac App Store Tailscale builds.
    if (state.mode !== "network-accessible" && !state.tailscaleServeEnabled) {
      return coreEndpoints;
    }

    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: state.port,
      serveEnabled: state.tailscaleServeEnabled,
      servePort: state.tailscaleServePort,
      networkInterfaces: currentNetworkInterfaces,
      readMagicDnsName: cachedReadMagicDnsName,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return [...coreEndpoints, ...tailscaleEndpoints];
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setMode,
    setTailscaleServeEnabled,
    setTunnelPairing,
    getAdvertisedEndpoints,
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
