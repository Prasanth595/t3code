/**
 * The source control drivers this build ships with. Both registries, repository operations and
 * pull requests, iterate this list; a host with no driver here shows up as unsupported.
 *
 * Adding a host means writing its `@t3tools/source-control-<host>` package, adding its driver
 * here, and providing its services' layers in `layer` below.
 *
 * @module sourceControl/builtInDrivers
 */
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as AzureDevOpsDriver from "@t3tools/source-control-azure-devops/server/driver";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as BitbucketPullRequestApi from "@t3tools/source-control-bitbucket/server/BitbucketPullRequestApi";
import * as BitbucketDriver from "@t3tools/source-control-bitbucket/server/driver";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as ForgejoDriver from "@t3tools/source-control-forgejo/server/driver";
import * as GitCafeApi from "@t3tools/source-control-gitcafe/server/GitCafeApi";
import * as GitCafeCredentials from "@t3tools/source-control-gitcafe/server/GitCafeCredentials";
import * as GitCafeDriver from "@t3tools/source-control-gitcafe/server/driver";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import type { SourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Undici from "@effect/platform-node/Undici";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const drivers = [
  GitHubDriver.driver,
  GitLabDriver.driver,
  AzureDevOpsDriver.driver,
  BitbucketDriver.driver,
  ForgejoDriver.driver,
  GitCafeDriver.driver,
];

/** Every service a built-in driver's `make` needs; the server's layers must provide them all. */
export type BuiltInSourceControlDriversEnv =
  (typeof drivers)[number] extends SourceControlDriver<infer R> ? R : never;

/** Ordered as the hosts appear in discovery. */
export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = drivers;

/**
 * The client the HTTP drivers read through: fetch, so redirects and headers behave as before, over
 * one pool of its own. The server's fetch drops a connection after four idle seconds and opens one
 * per concurrent request, so nearly every pull request opened after a pause paid a new TLS
 * handshake per read. This pool keeps connections for minutes, or for as long as the host does,
 * and carries a panel's parallel reads over one HTTP/2 connection where the host offers it.
 * Fresh, since the server builds the same `FetchHttpClient.layer` for itself and a memoized one
 * would ignore the `Fetch` given here.
 */
const httpDriverClient = Layer.fresh(FetchHttpClient.layer).pipe(
  Layer.provide(
    Layer.effect(FetchHttpClient.Fetch)(
      Effect.acquireRelease(
        Effect.sync(() => {
          const options = {
            allowH2: true,
            keepAliveTimeout: 300_000,
            keepAliveMaxTimeout: 300_000,
          };
          // Match Node's proxy opt-in, including flags supplied through NODE_OPTIONS.
          const proxyFlags = [
            ...(process.env.NODE_OPTIONS?.match(/--(?:no-)?use-env-proxy\b/g) ?? []),
            ...process.execArgv,
          ];
          const proxyFlag = proxyFlags.findLast(
            (flag) => flag === "--use-env-proxy" || flag === "--no-use-env-proxy",
          );
          const useProxy =
            proxyFlag === undefined
              ? process.env.NODE_USE_ENV_PROXY === "1"
              : proxyFlag === "--use-env-proxy";
          return useProxy ? new Undici.EnvHttpProxyAgent(options) : new Undici.Agent(options);
        }),
        (dispatcher) => Effect.promise(() => dispatcher.destroy()),
      ).pipe(
        // Node's own fetch types and this undici's describe the same init and response, but name
        // a different `Dispatcher`, so they meet through `unknown`.
        Effect.map(
          (dispatcher): typeof globalThis.fetch =>
            (input, init) =>
              Undici.fetch(input as Undici.RequestInfo, {
                ...(init as unknown as Undici.RequestInit),
                dispatcher,
              }) as unknown as Promise<Response>,
        ),
      ),
    ),
  ),
);

/** The services the built-in drivers' packages own, plus the host port they all run against. */
export const layer = Layer.mergeAll(
  // `GitHubApi.layerWithDependencies` carries the quota reserve and rate-limit pause every GitHub
  // reader shares, so the server builds it once, here.
  GitHubPullRequestApi.layer.pipe(Layer.provideMerge(GitHubApi.layerWithDependencies)),
  AzureDevOpsPullRequestCli.layer.pipe(Layer.provideMerge(AzureDevOpsCli.layer)),
  BitbucketPullRequestApi.layer.pipe(Layer.provideMerge(BitbucketApi.layer)),
  ForgejoCli.layer,
  GitCafeApi.layer.pipe(Layer.provideMerge(GitCafeCredentials.layer)),
  GitLabPullRequestCli.layer.pipe(Layer.provideMerge(GitLabCli.layer)),
).pipe(Layer.provide(httpDriverClient), Layer.provideMerge(ServerSourceControlHost.layer));
