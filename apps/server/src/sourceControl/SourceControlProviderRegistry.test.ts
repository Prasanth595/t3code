import {
  DEFAULT_SERVER_SETTINGS,
  SourceControlProviderKind,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as BitbucketPullRequestApi from "@t3tools/source-control-bitbucket/server/BitbucketPullRequestApi";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as GitCafeApi from "@t3tools/source-control-gitcafe/server/GitCafeApi";
import * as GitCafeCredentials from "@t3tools/source-control-gitcafe/server/GitCafeCredentials";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
  readonly process?: Partial<VcsProcess.VcsProcess["Service"]>;
  readonly githubApi?: Partial<GitHubApi.GitHubApi["Service"]>;
  readonly gitlab?: Partial<GitLabCli.GitLabCli["Service"]>;
  readonly forgejo?: Partial<ForgejoCli.ForgejoCli["Service"]>;
  readonly settingsChanges?: Stream.Stream<ContractServerSettings>;
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
}) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const layerRegistry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriver.VcsDriver["Service"]),
    resolve:
      input.resolve ??
      (() =>
        Effect.succeed({
          kind: "git",
          repository: {
            kind: "git",
            rootPath: "/repo",
            metadataPath: null,
            freshness: {
              source: "live-local" as const,
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: driver as unknown as VcsDriver.VcsDriver["Service"],
        })),
  });

  const layerProcess = Layer.mock(VcsProcess.VcsProcess)({
    run: () => Effect.succeed(processOutput("")),
    ...input.process,
  });

  return SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        layerRegistry,
        layerProcess,
        ServerSourceControlHost.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerProcess,
              layerRegistry,
              ServerSettings.ServerSettingsService.layerTest(),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            ),
          ),
        ),
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)({}),
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({
          subscribeChanges: Effect.succeed(input.settingsChanges ?? Stream.empty),
        }),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({}),
        Layer.mock(GitHubApi.GitHubApi)({
          // No GitHub credential unless a test supplies one, so custom hosts stay unclaimed.
          credential: (host) => Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
          ...input.githubApi,
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(GitLabCli.GitLabCli)(input.gitlab ?? {}),
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({}),
        Layer.mock(ForgejoCli.ForgejoCli)({
          listLogins: () => Effect.succeed([]),
          ...input.forgejo,
        }),
        Layer.mock(GitCafeApi.GitCafeApi)({}),
        Layer.mock(GitCafeCredentials.GitCafeCredentials)({
          cliEnv: () => Effect.succeed({}),
        }),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("routes GitHub remotes to the GitHub provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:pingdotgg/t3code.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("routes directly by provider kind for remote-first workflows", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [],
    });

    const provider = yield* registry.get(SourceControlProviderKind.make("github"));

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("includes the request cwd when an unregistered provider is used", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ remotes: [] });
    const provider = yield* registry.get(SourceControlProviderKind.make("unknown"));

    const error = yield* provider
      .getChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "getChangeRequest");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.reference, "#42");
  }),
);

it.effect("retains VCS detection failures with structured cwd context", () =>
  Effect.gen(function* () {
    const cause = new VcsRepositoryDetectionError({
      operation: "resolve",
      cwd: "/repo",
      detail: "raw VCS detection failure",
      cause: new Error("raw nested failure"),
    });
    const registry = yield* makeRegistry({
      remotes: [],
      resolve: () => Effect.fail(cause),
    });

    const error = yield* registry.resolve({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "detectProvider");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.detail, "Failed to detect source control provider.");
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes(cause.message), false);
  }),
);

it.effect("routes GitLab remotes to the GitLab provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@gitlab.com:group/project.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("routes authenticated self-hosted GitLab remotes without relying on host naming", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "https://self-hosted.example.test/group/project.git" }],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(
              `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
              { exitCode: ChildProcessSpawner.ExitCode(1) },
            ),
          ),
      },
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("refines the caller-selected remote instead of choosing another configured remote", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:fork/project.git" }],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(`self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
`),
          ),
      },
    });

    const handle = yield* registry.resolveHandle({
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("unknown"),
          name: "self-hosted.example.test",
          baseUrl: "https://self-hosted.example.test",
        },
        remoteName: "upstream",
        remoteUrl: "https://self-hosted.example.test/group/project.git",
      },
    });

    assert.strictEqual(handle.context?.provider.kind, "gitlab");
    assert.strictEqual(handle.context?.remoteName, "upstream");
  }),
);

it.effect("routes authenticated self-hosted GitLab remotes on non-standard ports", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "https://self-hosted.example.test:8443/group/project.git" }],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(
              `self-hosted.example.test:8443
  ✓ Logged in to self-hosted.example.test:8443 as gitlab-user
  ✓ Token found: ******
`,
            ),
          ),
      },
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("routes Bitbucket remotes to the Bitbucket provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@bitbucket.org:pingdotgg/t3code.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "bitbucket");
  }),
);

it.effect("routes Azure DevOps remotes to the Azure DevOps provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "https://dev.azure.com/acme/project/_git/repo" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);

it.effect("falls back to a non-origin remote when origin is not configured", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "upstream", url: "https://dev.azure.com/acme/project/_git/repo" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);

it.effect(
  "routes linked subjects by URL independently of the checkout and skips unsupported links",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        remotes: [{ name: "origin", url: "https://github.com/unrelated/checkout.git" }],
        githubApi: {
          rest: () =>
            Effect.succeed({
              status: 200,
              headers: {},
              body: JSON.stringify({ title: "GitHub issue", body: null }),
              truncated: false,
              invalidUtf8: false,
            }),
        },
        gitlab: {
          execute: () =>
            Effect.succeed(
              processOutput(JSON.stringify({ title: "GitLab MR", description: "Nested project" })),
            ),
        },
      });
      for (const [url, expected] of [
        ["https://github.com/team/project/issues/1", { title: "GitHub issue", body: null }],
        [
          "https://gitlab.com/team/sub/project/-/merge_requests/2",
          { title: "GitLab MR", body: "Nested project" },
        ],
      ] as const) {
        const lookup = registry.resolveLink({ cwd: "/unrelated", url: new URL(url) });
        assert.ok(lookup);
        assert.deepStrictEqual(yield* lookup, expected);
      }
      for (const url of [
        "https://example.test/team/project/issues/1",
        "https://github.attacker.test/team/project/issues/1",
        "https://gitlab.attacker.test/team/project/-/issues/1",
        "https://github.com/team/project",
        "https://codeberg.org/team/project/issues/1",
        "https://bitbucket.org/team/project/pull-requests/1",
        "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
        "http://github.com/team/project/issues/1",
        "https://user:secret@github.com/team/project/issues/1",
      ]) {
        assert.strictEqual(
          registry.resolveLink({ cwd: "/unrelated", url: new URL(url) }),
          undefined,
        );
      }
    }).pipe(Effect.scoped),
);

it.effect.each([
  { name: "a credential", credential: "found", expected: "github" },
  // Claimed so the error says the host is turned off, not that it is unsupported.
  { name: "a host turned off in Settings", credential: "disabled", expected: "github" },
  { name: "no credential", credential: "missing", expected: "unknown" },
] as const)("resolves custom-host remotes with $name", (scenario) =>
  Effect.gen(function* () {
    const hosts: Array<string> = [];
    const commands: Array<string> = [];
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@code.example.test:team/project.git" }],
      process: {
        run: ({ command }) => {
          commands.push(command);
          return Effect.succeed(processOutput(""));
        },
      },
      githubApi: {
        credential: (host) => {
          hosts.push(host);
          return scenario.credential === "found"
            ? Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:fingerprint` })
            : scenario.credential === "disabled"
              ? Effect.fail(new GitHubCredentials.GitHubHostDisabledError({ host }))
              : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }));
        },
      },
    });
    const handle = yield* registry.resolveHandle({ cwd: "/repo" });
    assert.strictEqual(handle.provider.kind, SourceControlProviderKind.make(scenario.expected));
    assert.strictEqual(handle.context?.provider.baseUrl, "https://code.example.test");
    assert.deepStrictEqual(hosts, ["code.example.test"]);
    // Recognition goes through the credential layer; gh is only one of its sources.
    assert.notInclude(commands, "gh");
  }),
);

it.effect("skips GitHub discovery for the identity resolver's empty base URL", () =>
  Effect.gen(function* () {
    const hosts: string[] = [];
    const remoteUrl = "git@githubenterprise.dev.example.com:team/workspace.git";
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: remoteUrl }],
      githubApi: {
        credential: (host) => {
          hosts.push(host);
          return Effect.succeed({
            token: Redacted.make("token"),
            fingerprint: `${host}:fingerprint`,
          });
        },
      },
    });
    const context = {
      provider: { kind: SourceControlProviderKind.make("unknown"), name: "Unknown", baseUrl: "" },
      remoteName: "origin",
      remoteUrl,
    };
    const unresolved = yield* registry.resolveHandle({ cwd: "/repo", context });
    assert.deepStrictEqual(unresolved.context, context);
    assert.deepStrictEqual(hosts, []);

    const resolved = yield* registry.resolveHandle({ cwd: "/repo" });
    assert.strictEqual(resolved.provider.kind, "github");
    assert.strictEqual(
      resolved.context?.provider.baseUrl,
      "https://githubenterprise.dev.example.com",
    );
    assert.deepStrictEqual(hosts, ["githubenterprise.dev.example.com"]);
  }),
);

// What PullRequestService and GitManager pass for a remote whose host names no integration.
const unknownRemote = (remoteUrl: string) => ({
  provider: {
    kind: SourceControlProviderKind.make("unknown"),
    name: "git.example.internal",
    baseUrl: "https://git.example.internal",
  },
  remoteName: "origin",
  remoteUrl,
});

// The spawner checks the cwd before it spawns, so a missing checkout fails in `FileSystem` and only
// a missing executable fails in `ChildProcess`.
const spawnError = (
  command: string,
  cwd: string,
  reason: "NotFound" | "PermissionDenied",
  module: "ChildProcess" | "FileSystem",
) =>
  new VcsProcessSpawnError({
    operation: "source-control.discovery.refine-unknown-remote",
    command,
    cwd,
    cause: PlatformError.systemError({
      _tag: reason,
      module,
      method: module === "ChildProcess" ? "spawn" : "access",
      pathOrDescriptor: module === "ChildProcess" ? command : cwd,
    }),
  });

const missingCli = (command: string, cwd: string) =>
  spawnError(command, cwd, "NotFound", "ChildProcess");

it.effect("asks the hosting CLIs once for every checkout of an unclaimed host", () =>
  Effect.gen(function* () {
    // No hosting CLI is installed and GitHub holds no credential, so every integration answers no.
    const makeUnclaimedRegistry = (beforeSpawn: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const commands: Array<string> = [];
        const logins: Array<string> = [];
        const hosts: Array<string> = [];
        const registry = yield* makeRegistry({
          remotes: [],
          process: {
            run: ({ command, cwd }) => {
              commands.push(command);
              return beforeSpawn.pipe(Effect.andThen(Effect.fail(missingCli(command, cwd))));
            },
          },
          githubApi: {
            credential: (host) => {
              hosts.push(host);
              return Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }));
            },
          },
          forgejo: {
            listLogins: ({ command, cwd }) => {
              logins.push(command);
              return command === "fj"
                ? Effect.succeed([])
                : Effect.fail(
                    new ForgejoCli.ForgejoCliError({
                      command,
                      cwd,
                      reason: "missing-cli",
                      detail: "tea is not installed.",
                      cause: missingCli(command, cwd),
                    }),
                  );
            },
          },
        });
        return { registry, commands, logins, hosts };
      });
    const checkouts = ["a", "b", "c"].map((name) => ({
      cwd: `/${name}`,
      remoteUrl: `https://git.example.internal/team/${name}.git`,
    }));
    const resolveCheckout = (
      registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
      checkout: (typeof checkouts)[number],
    ) => registry.resolveHandle({ cwd: checkout.cwd, context: unknownRemote(checkout.remoteUrl) });

    const sequential = yield* makeUnclaimedRegistry(Effect.void);
    for (const checkout of [...checkouts, ...checkouts]) {
      const handle = yield* resolveCheckout(sequential.registry, checkout);
      assert.strictEqual(handle.provider.kind, "unknown");
      // One answer serves the host; each checkout keeps its own remote.
      assert.strictEqual(handle.context?.remoteUrl, checkout.remoteUrl);
    }
    assert.deepStrictEqual(sequential.commands, ["glab"]);
    assert.deepStrictEqual(sequential.logins, ["fj", "tea"]);
    assert.deepStrictEqual(sequential.hosts, ["git.example.internal"]);

    // Checkouts that ask at the same time wait for the first one's probes.
    const spawned = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const concurrent = yield* makeUnclaimedRegistry(
      Deferred.succeed(spawned, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const lookups = yield* Effect.forEach(
      checkouts,
      (checkout) => resolveCheckout(concurrent.registry, checkout),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Deferred.await(spawned);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    const handles = yield* Fiber.join(lookups);
    assert.deepStrictEqual(
      handles.map((handle) => handle.context?.remoteUrl),
      checkouts.map((checkout) => checkout.remoteUrl),
    );
    assert.deepStrictEqual(concurrent.commands, ["glab"]);
  }),
);

// GitHub holds no credential for the host until `signIn`, as after a `gh auth login` in a terminal.
const makeSignInRegistry = (
  settingsChanges: Stream.Stream<ContractServerSettings> = Stream.empty,
) =>
  Effect.gen(function* () {
    let signedIn = false;
    const hosts: Array<string> = [];
    const commands: Array<string> = [];
    const registry = yield* makeRegistry({
      remotes: [],
      settingsChanges,
      process: {
        run: ({ command }) => {
          commands.push(command);
          return Effect.succeed(processOutput(""));
        },
      },
      githubApi: {
        credential: (host) => {
          hosts.push(host);
          return signedIn
            ? Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:fingerprint` })
            : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }));
        },
      },
    });
    return {
      hosts,
      commands,
      signIn: () => {
        signedIn = true;
      },
      resolveKind: registry
        .resolveHandle({
          cwd: "/repo",
          context: unknownRemote("https://git.example.internal/team/a.git"),
        })
        .pipe(Effect.map((handle) => handle.provider.kind)),
    };
  });

it.effect("notices a CLI login made outside the app once the verdict expires", () =>
  Effect.gen(function* () {
    const github = yield* makeSignInRegistry();

    assert.strictEqual(yield* github.resolveKind, "unknown");
    github.signIn();
    yield* TestClock.adjust(Duration.minutes(4));
    assert.strictEqual(yield* github.resolveKind, "unknown");
    assert.deepStrictEqual(github.hosts, ["git.example.internal"]);
    assert.deepStrictEqual(github.commands, ["glab"]);

    yield* TestClock.adjust(Duration.minutes(1));
    assert.strictEqual(yield* github.resolveKind, "github");
    assert.deepStrictEqual(github.hosts, ["git.example.internal", "git.example.internal"]);
  }),
);

it.effect("asks again as soon as settings change", () =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ContractServerSettings>();
    const github = yield* makeSignInRegistry(
      Stream.fromSubscription(yield* PubSub.subscribe(changes)),
    );

    assert.strictEqual(yield* github.resolveKind, "unknown");
    // A token saved in Settings; the registry hears of it only through the settings stream.
    github.signIn();
    assert.strictEqual(yield* github.resolveKind, "unknown");
    yield* PubSub.publish(changes, DEFAULT_SERVER_SETTINGS);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    assert.strictEqual(yield* github.resolveKind, "github");
    assert.deepStrictEqual(github.hosts, ["git.example.internal", "git.example.internal"]);
  }),
);

const signedInGitLab = processOutput(`git.example.internal
  ✓ Logged in to git.example.internal as gitlab-user
`);

it.effect.each([
  { name: "a missing checkout", failure: "missing-checkout" },
  { name: "a glab timeout", failure: "timeout" },
  { name: "glab without permission to run", failure: "permission-denied" },
  { name: "a tea failure", failure: "tea" },
] as const)("does not keep an answer a checkout could not reach: $name", (scenario) =>
  Effect.gen(function* () {
    // The checkouts that reached the failing CLI.
    const asked: Array<string> = [];
    const glabFailure = (cwd: string) =>
      scenario.failure === "missing-checkout"
        ? spawnError("glab", cwd, "NotFound", "FileSystem")
        : scenario.failure === "timeout"
          ? new VcsProcessTimeoutError({
              operation: "source-control.discovery.refine-unknown-remote",
              command: "glab",
              cwd,
              timeoutMs: 5_000,
            })
          : spawnError("glab", cwd, "PermissionDenied", "ChildProcess");
    const registry = yield* makeRegistry({
      remotes: [],
      process: {
        run: ({ command, cwd }) => {
          if (scenario.failure === "tea") return Effect.fail(missingCli(command, cwd));
          asked.push(cwd);
          return cwd === "/gone" ? Effect.fail(glabFailure(cwd)) : Effect.succeed(signedInGitLab);
        },
      },
      forgejo: {
        listLogins: ({ command, cwd }) => {
          if (scenario.failure !== "tea" || command === "fj") return Effect.succeed([]);
          asked.push(cwd);
          return cwd === "/gone"
            ? Effect.fail(
                new ForgejoCli.ForgejoCliError({
                  command,
                  cwd,
                  detail: "Forgejo CLI command failed.",
                }),
              )
            : Effect.succeed([
                {
                  name: "forge",
                  url: "https://git.example.internal",
                  user: "forgejo-user",
                  default: "true",
                },
              ]);
        },
      },
    });
    const context = unknownRemote("https://git.example.internal/team/a.git");

    const gone = yield* registry.resolveHandle({ cwd: "/gone", context });
    assert.strictEqual(gone.provider.kind, "unknown");
    // A healthy checkout of the same remote asks again and gets its own answer.
    const healthy = yield* registry.resolveHandle({ cwd: "/healthy", context });
    assert.strictEqual(healthy.provider.kind, scenario.failure === "tea" ? "forgejo" : "gitlab");
    assert.deepStrictEqual(asked, ["/gone", "/healthy"]);
  }),
);

it.effect("keeps Forgejo mounts on one host apart", () =>
  Effect.gen(function* () {
    const logins: Array<string> = [];
    const registry = yield* makeRegistry({
      remotes: [],
      forgejo: {
        listLogins: ({ command }) => {
          logins.push(command);
          return Effect.succeed(
            command === "tea"
              ? [
                  {
                    name: "forge-one",
                    url: "https://git.example.internal/forge-one",
                    user: "forgejo-user",
                    default: "true",
                  },
                ]
              : [],
          );
        },
      },
    });
    const resolveContext = (cwd: string, remoteUrl: string) =>
      registry
        .resolveHandle({ cwd, context: unknownRemote(remoteUrl) })
        .pipe(Effect.map((handle) => handle.context));

    const mounted = yield* resolveContext(
      "/a",
      "https://git.example.internal/forge-one/team/a.git",
    );
    assert.strictEqual(mounted?.provider.kind, "forgejo");
    assert.strictEqual(mounted?.provider.baseUrl, "https://git.example.internal/forge-one");
    // The login serves only its mount, so another installation on the host stays unclaimed.
    const outside = yield* resolveContext(
      "/b",
      "https://git.example.internal/forge-two/team/b.git",
    );
    assert.strictEqual(outside?.provider.kind, "unknown");
    const sibling = yield* resolveContext(
      "/c",
      "https://git.example.internal/forge-one/team/c.git",
    );
    assert.strictEqual(sibling?.provider.kind, "forgejo");
    assert.strictEqual(sibling?.provider.baseUrl, "https://git.example.internal/forge-one");
    assert.strictEqual(sibling?.remoteUrl, "https://git.example.internal/forge-one/team/c.git");
    assert.deepStrictEqual(logins, ["fj", "tea", "fj", "tea"]);
  }),
);
