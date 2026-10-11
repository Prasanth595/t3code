import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import type {} from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as BuiltInDrivers from "./builtInDrivers.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
  type SourceControlProviderDiscoverySpec,
  type UnknownRemoteVerdict,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);
const UNKNOWN_REMOTE_CACHE_CAPACITY = 512;
// A login made in a terminal (`gh auth login`, `tea login add`) sends the server no signal, so
// each host is asked again after this long.
const UNKNOWN_REMOTE_CACHE_TTL = Duration.minutes(5);

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  {
    readonly resolveLink: SourceControlProvider.ResolveSourceControlLink;
    readonly get: (
      kind: SourceControlProviderKind,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly resolveHandle: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
    readonly resolve: (input: {
      readonly cwd: string;
    }) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
  }
>()("t3/sourceControl/SourceControlProviderRegistry") {}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProvider["Service"] {
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "listChangeRequests",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    getChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.headSelector),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getRepositoryCloneUrls: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getRepositoryCloneUrls",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getDefaultBranch: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getDefaultBranch",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    checkoutChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "checkoutChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
  });
}

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>,
): SourceControlProvider.SourceControlProviderContext | null {
  const candidates: Array<SourceControlProvider.SourceControlProviderContext> = [];
  for (const remote of remotes) {
    const provider = detectSourceControlProviderFromRemoteUrl(remote.url);
    if (provider) {
      candidates.push({
        provider,
        remoteName: remote.name,
        remoteUrl: remote.url,
      });
    }
  }

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
    candidates[0] ??
    null
  );
}

// What the refiners read, minus `owner/repo`: the provider name and base URL (GitHub, GitLab),
// the remote's scheme, host, port and any installation mount (Forgejo), and a requested host.
// Scheme and host ignore case; a mount path does not, as Forgejo login matching compares it as is.
function unknownRemoteKey(context: SourceControlProvider.SourceControlProviderContext): string {
  const remote = context.remoteUrl
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  const url = /^[a-z][a-z0-9+.-]*:\/\//iu.test(remote) ? URL.parse(remote) : null;
  const server = url
    ? `${url.protocol}//${url.host.toLowerCase()}${url.pathname.split("/").slice(0, -2).join("/")}`
    : remote
        .replace(/^[^@/]+@/u, "")
        .replace(/:.*$/u, "")
        .toLowerCase(); // SCP form: the host alone
  return [
    context.provider.name,
    context.provider.baseUrl,
    server,
    context.requestedHost?.toLowerCase() ?? "",
  ].join("\u0000");
}

/** Checkouts of one server share a lookup; the first to ask supplies the cwd and context. */
class UnknownRemoteRequest {
  readonly key: string;
  readonly cwd: string;
  readonly context: SourceControlProvider.SourceControlProviderContext;

  constructor(cwd: string, context: SourceControlProvider.SourceControlProviderContext) {
    this.key = unknownRemoteKey(context);
    this.cwd = cwd;
    this.context = context;
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof UnknownRemoteRequest && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProvider["Service"],
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProvider["Service"] {
  if (context === null) {
    return provider;
  }

  return SourceControlProvider.SourceControlProvider.of({
    ...provider,
    listChangeRequests: (input) =>
      provider.listChangeRequests({
        ...input,
        context: input.context ?? context,
      }),
    getChangeRequest: (input) =>
      provider.getChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    createChangeRequest: (input) =>
      provider.createChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    getRepositoryCloneUrls: (input) =>
      provider.getRepositoryCloneUrls({
        ...input,
        context: input.context ?? context,
      }),
    createRepository: (input) => provider.createRepository(input),
    getDefaultBranch: (input) =>
      provider.getDefaultBranch({
        ...input,
        context: input.context ?? context,
      }),
    checkoutChangeRequest: (input) =>
      provider.checkoutChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const { process } = yield* SourceControlHost.SourceControlHost;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProvider["Service"]
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);

    const get: SourceControlProviderRegistry["Service"]["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    // Only a settled verdict is kept. One a checkout could not reach is shared with the lookups
    // already waiting on it, then dropped.
    const unknownRemoteCache = yield* Cache.makeWith<UnknownRemoteRequest, UnknownRemoteVerdict>(
      (request) =>
        refineUnknownRemoteProvider({
          specs: discoverySpecs,
          process,
          cwd: request.cwd,
          context: request.context,
        }),
      {
        capacity: UNKNOWN_REMOTE_CACHE_CAPACITY,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.settled ? UNKNOWN_REMOTE_CACHE_TTL : Duration.zero,
      },
    );
    // A token, account or host switch saved in Settings changes what GitHub claims.
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* Stream.runForEach(settingsChanges, () => Cache.invalidateAll(unknownRemoteCache)).pipe(
      Effect.forkScoped,
    );

    // The verdict for the remote's server, applied to this caller's own context.
    const refineRemote = (
      cwd: string,
      context: SourceControlProvider.SourceControlProviderContext | null,
    ): Effect.Effect<SourceControlProvider.SourceControlProviderContext | null> =>
      context === null || context.provider.kind !== "unknown"
        ? Effect.succeed(context)
        : Cache.get(unknownRemoteCache, new UnknownRemoteRequest(cwd, context)).pipe(
            Effect.map((verdict) =>
              verdict.provider ? { ...context, provider: verdict.provider } : context,
            ),
          );

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
        const handle = yield* vcsRegistry.resolve({ cwd }).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("unknown"),
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const remotes = yield* handle.driver.listRemotes(cwd).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("unknown"),
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const context = selectProviderContext(remotes.remotes);

        return yield* refineRemote(cwd, context);
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    const resolveHandle: SourceControlProviderRegistry["Service"]["resolveHandle"] = (input) =>
      (input.context === undefined
        ? Cache.get(providerContextCache, input.cwd)
        : refineRemote(input.cwd, input.context)
      ).pipe(
        Effect.map((context) => {
          const kind = context?.provider.kind ?? SourceControlProviderKind.make("unknown");
          const provider = providers.get(kind) ?? unsupportedProvider(kind);
          return {
            provider: bindProviderContext(provider, context),
            context,
          } satisfies SourceControlProviderHandle;
        }),
      );

    return SourceControlProviderRegistry.of({
      resolveLink: (input) => {
        if (input.url.protocol !== "https:" || input.url.username || input.url.password) {
          return undefined;
        }
        const kind = detectSourceControlProviderFromRemoteUrl(input.url.href)?.kind;
        return kind ? providers.get(kind)?.resolveLink?.(input) : undefined;
      },
      get,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
      discover: Effect.forEach(
        discoverySpecs,
        (spec) =>
          probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
          }),
        { concurrency: "unbounded" },
      ),
    });
  },
);

export const make = Effect.gen(function* () {
  const drivers = yield* Effect.forEach(BuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS, (driver) =>
    driver.make.pipe(
      Effect.map((instance): SourceControlProviderRegistration => ({
        kind: driver.kind,
        provider: instance.sourceControl,
        discovery: instance.discovery,
      })),
    ),
  );
  return yield* makeWithProviders(drivers);
});

export const layer = Layer.effect(SourceControlProviderRegistry, make);
