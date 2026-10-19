import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandAvailability, WindowsShellEnvironment } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { assert, it, vi } from "vite-plus/test";

import { fixPath, hydratePosixEnvironment, hydratePosixHome } from "./os-jank.ts";

it.each(["linux", "darwin"] as const)(
  "hydrates the SSH agent and merges PATH from the login shell on %s",
  (platform) => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/service/bin", SHELL: "/bin/bash" };

    hydratePosixEnvironment(env, platform, () => ({
      PATH: "/shell/bin:/usr/bin",
      SSH_AUTH_SOCK: "/opt/orbstack-guest/run/host-ssh-agent.sock",
    }));

    assert.equal(env.SSH_AUTH_SOCK, "/opt/orbstack-guest/run/host-ssh-agent.sock");
    assert.equal(env.PATH, "/shell/bin:/usr/bin:/service/bin");
  },
);

it("preserves an explicitly forwarded SSH agent", () => {
  const env: NodeJS.ProcessEnv = { SSH_AUTH_SOCK: "/forwarded/agent.sock" };

  hydratePosixEnvironment(env, "linux", () => ({
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "/login/agent.sock",
  }));

  assert.equal(env.SSH_AUTH_SOCK, "/forwarded/agent.sock");
});

it("takes the agent from the accepted shell when an earlier candidate has no PATH", () => {
  const env: NodeJS.ProcessEnv = { SHELL: "/custom/shell-without-path" };

  hydratePosixEnvironment(env, "linux", (shell) =>
    shell === env.SHELL
      ? { SSH_AUTH_SOCK: "/stale/agent.sock" }
      : { PATH: "/usr/bin", SSH_AUTH_SOCK: "/current/agent.sock" },
  );

  assert.equal(env.SSH_AUTH_SOCK, "/current/agent.sock");
  assert.equal(env.PATH, "/usr/bin");
});

it("leaves the SSH agent unset when the login shell has none", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/service/bin" };

  hydratePosixEnvironment(env, "linux", () => ({ PATH: "/usr/bin" }));

  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PATH, "/usr/bin:/service/bin");
});

it("reads the current agent socket for each fresh service environment", () => {
  const first: NodeJS.ProcessEnv = {};
  const next: NodeJS.ProcessEnv = {};
  let socket = "/run/user/1000/agent-first.sock";
  const readShellEnvironment = () => ({ PATH: "/usr/bin", SSH_AUTH_SOCK: socket });

  hydratePosixEnvironment(first, "linux", readShellEnvironment);
  socket = "/run/user/1000/agent-next.sock";
  hydratePosixEnvironment(next, "linux", readShellEnvironment);

  assert.equal(first.SSH_AUTH_SOCK, "/run/user/1000/agent-first.sock");
  assert.equal(next.SSH_AUTH_SOCK, "/run/user/1000/agent-next.sock");
});

vi.mock("node:child_process", { spy: true });

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect.each(["darwin", "linux"] as const)(
  "keeps the prepared PATH and still hydrates HOME on %s",
  (platform) =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(NodeChildProcess, "execFileSync")),
      (probe) =>
        Effect.gen(function* () {
          probe.mockImplementation(() => {
            throw new Error("The prepared environment must not launch another shell");
          });
          const env: NodeJS.ProcessEnv = { PATH: "/prepared/bin:/usr/bin" };

          yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );

          assert.equal(probe.mock.calls.length, 0);
          assert.equal(env.PATH, "/prepared/bin:/usr/bin");
          assert.equal(env.HOME, NodeOS.userInfo().homedir);
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__T3CODE_ENV_PATH_START__\n/opt/tools/bin\n__T3CODE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__T3CODE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__T3CODE_ENV_PATH_END__",
            "__T3CODE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__T3CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps the prepared Windows PATH without probing", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Prepared\\Bin;C:\\Windows" };
    const commands: string[] = [];

    yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => {
        throw new Error("The prepared environment must not launch another shell");
      }),
      Effect.provideService(CommandAvailability, (command) =>
        Effect.sync(() => {
          commands.push(command);
          return true;
        }),
      ),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(commands, []);
    assert.equal(env.PATH, "C:\\Prepared\\Bin;C:\\Windows");
  }),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => ({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);
