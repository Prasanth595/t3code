import { SourceControlProviderKind } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const layerRepositoryIdentityResolverTest = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

const processOutput = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const layerRemoteResolver = (
  remotes: Readonly<Record<string, string>>,
  ssh: ProcessRunner.ProcessRunner["Service"]["run"],
) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make(),
  ).pipe(
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => {
          if (input.command === "ssh") return ssh(input);
          expect(input.command).toBe("git");
          return Effect.succeed(
            processOutput(
              input.args.includes("rev-parse")
                ? "/repo\n"
                : Object.entries(remotes)
                    .map(([name, url]) => `${name}\t${url} (fetch)\n`)
                    .join(""),
            ),
          );
        },
      }),
    ),
  );

const resolveRemote = (remoteUrl: string, ssh: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    return yield* resolver.resolve("/repo");
  }).pipe(Effect.provide(layerRemoteResolver({ origin: remoteUrl }, ssh)));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("refreshes the Git root only when requested", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootPath = "/repo";
    let remoteUrl = "git@github.com:T3Tools/t3code.git";
    let refinements = 0;
    let refinementFails = false;
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout: input.args.includes("rev-parse")
              ? `${rootPath}\n`
              : `origin\t${remoteUrl} (fetch)\n`,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make({
        refine: (identity) => {
          refinements++;
          if (refinementFails)
            return Effect.fail(
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("forgejo"),
                operation: "detectProvider",
                cwd: rootPath,
                detail: "account unavailable",
              }),
            );
          return Effect.succeed(
            identity.canonicalKey.startsWith("ssh.forge.test/")
              ? {
                  ...identity,
                  provider: "forgejo",
                  webUrl: "http://forge.test:3000/git/team/repo",
                }
              : identity,
          );
        },
      }),
    ).pipe(Layer.provide(layerProcessRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const first = yield* resolver.resolve("/repo/packages/web");
      rootPath = "/repo/packages/web";
      // Longer than the one-minute cadence of the background sweeps.
      yield* TestClock.adjust(Duration.minutes(10));
      const second = yield* resolver.resolve("/repo/packages/web");

      expect(first?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(second).toEqual(first);
      expect(refinements).toBe(1);
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);

      const refreshed = yield* resolver.resolve("/repo/packages/web", { refresh: true });
      expect(refreshed?.rootPath).toBe("/repo/packages/web");
      expect(yield* resolver.resolve("/repo/packages/web")).toEqual(refreshed);
      expect(calls.slice(2)).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "remote", "-v"],
      ]);
      remoteUrl = "git@ssh.forge.test:team/repo.git";
      const forgejo = yield* resolver.resolve(rootPath, { refresh: true });
      expect(forgejo?.webUrl).toBe("http://forge.test:3000/git/team/repo");
      expect(forgejo?.provider).toBe("forgejo");
      expect(forgejo?.canonicalKey).toBe("ssh.forge.test/team/repo");
      expect(forgejo?.locator.remoteUrl).toBe(remoteUrl);
      expect(yield* resolver.resolve(rootPath)).toEqual(forgejo);
      expect(refinements).toBe(3);
      refinementFails = true;
      const unavailable = yield* resolver.resolve(rootPath, { refresh: true });
      expect(unavailable?.webUrl).toBeUndefined();
      expect(unavailable?.canonicalKey).toBe("ssh.forge.test/team/repo");
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
  });

  it.effect("retries Git root discovery after the negative TTL", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootAttempts = 0;
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const rootLookup = input.args.includes("rev-parse");
          const failed = rootLookup && rootAttempts++ === 0;
          return {
            stdout: rootLookup
              ? failed
                ? ""
                : "/repo\n"
              : "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n",
            stderr: failed ? "temporary Git failure" : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(layerProcessRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();

      yield* TestClock.adjust(Duration.minutes(1));
      const recovered = yield* resolver.resolve("/repo/packages/web");
      expect(recovered?.rootPath).toBe("/repo");
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
  });

  it.effect("resolves an alias to its forge while preserving transport, casing, and cache", () => {
    let sshCalls = 0;
    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve("/repo");
      expect(identity).toMatchObject({
        canonicalKey: "github.com/t3tools/t3code",
        provider: "github",
        displayName: "T3Tools/T3Code",
        owner: "T3Tools",
        name: "T3Code",
        locator: { remoteName: "origin", remoteUrl: "gh:T3Tools/T3Code.git" },
      });
      expect(yield* resolver.resolve("/repo")).toEqual(identity);
      expect(sshCalls).toBe(1);
    }).pipe(
      Effect.provide(
        layerRemoteResolver({ origin: "gh:T3Tools/T3Code.git" }, () => {
          sshCalls++;
          return Effect.succeed(
            processOutput("hostname ssh.github.com\nuser localuser\nport 443\n"),
          );
        }),
      ),
    );
  });

  it.effect.each([
    {
      origin: "gh:Alice/Fork.git",
      fork: { canonicalKey: "github.com/alice/fork", displayName: "Alice/Fork" },
    },
    { origin: "https://github.com/T3Tools/T3Code.git", fork: undefined },
  ])("compares origin $origin with the resolved upstream", ({ origin, fork }) =>
    Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve("/repo");
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.origin).toEqual(fork);
      expect(identity?.locator).toMatchObject({
        remoteName: "upstream",
        remoteUrl: "gh:T3Tools/T3Code.git",
      });
    }).pipe(
      Effect.provide(
        layerRemoteResolver({ origin, upstream: "gh:T3Tools/T3Code.git" }, () =>
          Effect.succeed(processOutput("hostname github.com\nuser git\n")),
        ),
      ),
    ),
  );

  it.effect("keeps ambiguous personal-login aliases and absolute filesystem paths", () =>
    Effect.gen(function* () {
      const alice = () => Effect.succeed(processOutput("hostname server.test\nuser alice\n"));
      const bob = () =>
        Effect.succeed(processOutput("hostname server.test\nuser bob@corp.example\n"));
      expect((yield* resolveRemote("alice-box:app.git", alice))?.canonicalKey).toBe(
        "alice-box/app",
      );
      expect((yield* resolveRemote("bob-box:app.git", bob))?.canonicalKey).toBe("bob-box/app");
      const forge = yield* resolveRemote("forgejo@code.example.org:Team/App.git", () =>
        Effect.succeed(processOutput("hostname code.example.org\nuser forgejo\nport 22\n")),
      );
      expect(forge).toMatchObject({
        canonicalKey: "code.example.org/team/app",
        displayName: "Team/App",
        owner: "Team",
        name: "App",
      });
      const absolute = yield* resolveRemote("alice-box:/srv/app.git", alice);
      const shared = () => Effect.succeed(processOutput("hostname server.test\nuser git\n"));
      expect((yield* resolveRemote("git-box:srv/app.git", shared))?.canonicalKey).not.toBe(
        (yield* resolveRemote("git-box:/srv/app.git", shared))?.canonicalKey,
      );
      expect(absolute?.canonicalKey).toBe("alice-box:/srv/app");
      expect(
        (yield* resolveRemote("ssh://bob@server.test/srv/app.git", bob))?.canonicalKey,
      ).not.toBe(absolute?.canonicalKey);
    }),
  );

  it.effect("passes the remote login and port to a bounded SSH configuration lookup", () =>
    Effect.gen(function* () {
      const identity = yield* resolveRemote("git+ssh://git@review:2222/Team/App.git", (input) => {
        expect(input.args).toEqual(["-G", "-l", "git", "-p", "2222", "review"]);
        expect(Duration.toMillis(Duration.fromInputUnsafe(input.timeout!))).toBe(5_000);
        expect(input.timeoutBehavior).toBe("timedOutResult");
        return Effect.succeed(processOutput("hostname gitlab.com\nuser git\nport 2222\n"));
      });
      expect(identity?.canonicalKey).toBe("gitlab.com/team/app");
      expect(identity?.provider).toBe("gitlab");
      expect(identity?.displayName).toBe("Team/App");
      expect(identity?.owner).toBe("Team");
      expect(identity?.name).toBe("App");
      expect(identity?.locator.remoteUrl).toBe("git+ssh://git@review:2222/Team/App.git");
    }),
  );

  it.effect("keeps aliases distinct for loopback tunnels and ambiguous server ports", () =>
    Effect.gen(function* () {
      const tunnel = () => Effect.succeed(processOutput("hostname 127.0.0.1\nuser git\n"));
      expect((yield* resolveRemote("git@tunnel-a:Team/App.git", tunnel))?.canonicalKey).toBe(
        "tunnel-a/team/app",
      );
      expect((yield* resolveRemote("git@tunnel-b:Team/App.git", tunnel))?.canonicalKey).toBe(
        "tunnel-b/team/app",
      );

      const forge = yield* resolveRemote("git@gitlab.corp.example:Team/App.git", () =>
        Effect.succeed(processOutput("hostname 10.1.2.3\nuser git\n")),
      );
      expect(forge).toMatchObject({
        canonicalKey: "gitlab.corp.example/team/app",
        provider: "gitlab",
      });
      const ip = yield* resolveRemote("git@code.example.org:Team/App.git", () =>
        Effect.succeed(processOutput("hostname 203.0.113.7\nuser git\n")),
      );
      expect(ip?.canonicalKey).toBe("code.example.org/team/app");
      const proxied = yield* resolveRemote("client-a:Team/App.git", () =>
        Effect.succeed(processOutput("hostname internal.test\nuser git\nproxyjump bastion-a\n")),
      );
      const commanded = yield* resolveRemote("client-b:Team/App.git", () =>
        Effect.succeed(
          processOutput("hostname internal.test\nuser git\nproxycommand ssh -W %h:%p bastion-b\n"),
        ),
      );
      expect([proxied?.canonicalKey, commanded?.canonicalKey]).toEqual([
        "client-a/team/app",
        "client-b/team/app",
      ]);
      const dev1 = yield* resolveRemote("git@dev1:Team/App.git", () =>
        Effect.succeed(processOutput("hostname server.test\nuser git\nport 2222\n")),
      );
      const dev2 = yield* resolveRemote("git@dev2:Team/App.git", () =>
        Effect.succeed(processOutput("hostname server.test\nuser git\nport 2223\n")),
      );
      expect([dev1?.canonicalKey, dev2?.canonicalKey]).toEqual(["dev1/team/app", "dev2/team/app"]);
    }),
  );

  it.effect("does not probe HTTPS or public SSH forges", () =>
    Effect.gen(function* () {
      let sshCalls = 0;
      const ssh = () => {
        sshCalls++;
        return Effect.succeed(processOutput("hostname wrong.test\nuser wrong\n"));
      };
      for (const remote of [
        "https://github.com/Team/App.git",
        "git+ssh://git@github.com/Team/App.git",
        "git@github.com:Team/App.git",
        "git@ssh.github.com:Team/App.git",
      ]) {
        const identity = yield* resolveRemote(remote, ssh);
        expect(identity?.canonicalKey).toBe("github.com/team/app");
        expect(identity?.displayName).toBe("Team/App");
      }
      expect(sshCalls).toBe(0);
    }),
  );

  it.effect("never exposes unsafe remote hosts or logins to SSH Match exec", () =>
    Effect.gen(function* () {
      let sshCalls = 0;
      const ssh = () => {
        sshCalls++;
        return Effect.succeed(processOutput("hostname github.com\nuser git\n"));
      };
      for (const remote of [
        "-oProxyCommand=calc:Team/App.git",
        "x;id@gh:Team/App.git",
        "ssh://x%3Bid@gh/Team/App.git",
      ]) {
        expect((yield* resolveRemote(remote, ssh))?.locator.remoteUrl).toBe(remote);
      }
      expect(sshCalls).toBe(0);
    }),
  );

  it.effect.each(["exit", "timeout", "missing"] as const)(
    "keeps fallback identities when SSH lookup fails with %s",
    (failure) =>
      Effect.gen(function* () {
        const ssh = () =>
          failure === "missing"
            ? Effect.fail(
                new ProcessRunner.ProcessSpawnError({
                  command: "ssh",
                  argumentCount: 2,
                  cause: new Error("ENOENT"),
                }),
              )
            : Effect.succeed({
                ...processOutput("", 255),
                timedOut: failure === "timeout",
                code: failure === "timeout" ? null : ChildProcessSpawner.ExitCode(255),
              });
        expect((yield* resolveRemote("gh:Team/App.git", ssh))?.canonicalKey).toBe("gh/team/app");
        expect((yield* resolveRemote("alice@server.test:app.git", ssh))?.canonicalKey).toBe(
          "server.test/app",
        );
      }),
  );

  it.effect("resolves a host named constructor without reading inherited endpoint mappings", () =>
    Effect.gen(function* () {
      const identity = yield* resolveRemote("git@constructor:repo.git", () =>
        Effect.succeed(processOutput("hostname constructor\nuser git\n")),
      );
      expect(identity?.canonicalKey).toBe("constructor/repo");
      expect(identity?.locator.remoteUrl).toBe("git@constructor:repo.git");
    }),
  );

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath, since git reports the long form of a directory the
      // temp dir may name by its 8.3 short form on Windows.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("ignores local-path remotes such as GitButler's gb-local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const localOnlyDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-local-remote-",
      });
      const mixedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-mixed-remote-",
      });

      yield* git(localOnlyDir, ["init"]);
      yield* git(localOnlyDir, ["remote", "add", "gb-local", "."]);
      yield* git(localOnlyDir, ["remote", "add", "backup", "/srv/git/repo.git"]);
      yield* git(localOnlyDir, ["remote", "add", "archive", "file:///srv/git/repo.git"]);
      yield* git(mixedDir, ["init"]);
      yield* git(mixedDir, ["remote", "add", "gb-local", "."]);
      yield* git(mixedDir, ["remote", "add", "mirror", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(localOnlyDir)).toBeNull();

      const mixedIdentity = yield* resolver.resolve(mixedDir);
      expect(mixedIdentity?.locator.remoteName).toBe("mirror");
      expect(mixedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("T3Tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/julius/t3code-fork",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("T3Tools/platform/t3code");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(refreshedIdentity?.name).toBe("t3code");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            layerRepositoryIdentityResolverTest({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshedIdentity?.displayName).toBe("T3Tools/t3code-next");
      expect(refreshedIdentity?.name).toBe("t3code-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          layerRepositoryIdentityResolverTest({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});
