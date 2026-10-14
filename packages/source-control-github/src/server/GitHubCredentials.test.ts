import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

import { DEFAULT_SERVER_SETTINGS, VcsProcessTimeoutError } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubCredentials from "./GitHubCredentials.ts";

const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/** Settings keep `enabled` explicit; a host the test leaves it off is enabled. */
const hostSettings = (
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }>,
) =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, choice]) => [host, { enabled: true, ...choice }]),
  );

function harness(
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
  override?: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.suspend(() => {
      if (override !== undefined) {
        calls.push(input.args);
        return override(input);
      }
      return Effect.sync(() => {
        calls.push(input.args);
        const user = input.args[input.args.indexOf("--user") + 1];
        if (input.args.includes("--user") && user !== undefined && signedOut.includes(user)) {
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: input.args.includes("--user") ? `token-for-${user}\n` : "active-token\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      });
    });
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: { github: { hosts: hostSettings(hosts), tokens } },
        }),
        process: { run },
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { layer, calls };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("shares failed gh probes, backs off a locked keyring, and recovers", () => {
    let fails = true;
    const { layer, calls } = harness({}, [], {}, (input) =>
      fails
        ? Effect.fail(
            new VcsProcessTimeoutError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              timeoutMs: 10000,
            }),
          )
        : Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "recovered-token",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const failed = credentials.get("github.com").pipe(Effect.flip);
      const readers = yield* Effect.all(
        Array.from({ length: 50 }, () => failed),
        { concurrency: "unbounded" },
      );
      expect(readers.every((error) => error._tag === "GitHubCliFailedError")).toBe(true);
      expect(calls).toHaveLength(1);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* failed;
      expect(calls).toHaveLength(2);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* failed;
      expect(calls).toHaveLength(2);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* failed;
      expect(calls).toHaveLength(3);
      yield* TestClock.adjust(Duration.seconds(20));
      yield* failed;
      expect(calls).toHaveLength(4);
      yield* TestClock.adjust(Duration.seconds(40));
      yield* failed;
      expect(calls).toHaveLength(5);
      fails = false;
      yield* TestClock.adjust(Duration.seconds(59));
      yield* failed;
      expect(calls).toHaveLength(5);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("recovered-token");
      expect(calls).toHaveLength(6);
      yield* credentials.get("github.com");
      expect(calls).toHaveLength(6);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "explicit invalidation, a changed account, and saved tokens bypass failed-probe backoff",
    () => {
      const { layer, calls } = harness({}, [], {}, (input) =>
        Effect.fail(
          new VcsProcessTimeoutError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            timeoutMs: 10000,
          }),
        ),
      );
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
        const failed = credentials.get("github.com").pipe(Effect.flip);
        yield* failed;
        yield* failed;
        expect(calls).toHaveLength(1);
        yield* credentials.invalidate("GitHub.com");
        yield* failed;
        expect(calls).toHaveLength(2);
        yield* TestClock.adjust(Duration.seconds(5));
        yield* failed;
        expect(calls).toHaveLength(3);
        yield* settings.update({
          sourceControlHosts: {
            github: { hosts: { "github.com": { account: "work", enabled: true } } },
          },
        });
        yield* failed;
        expect(calls).toHaveLength(4);
        expect(calls.at(-1)).toEqual([
          "auth",
          "token",
          "--hostname",
          "github.com",
          "--user",
          "work",
        ]);
        yield* settings.update({
          sourceControlHosts: { github: { tokens: { "github.com": "new-saved-token" } } },
        });
        expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe(
          "new-saved-token",
        );
        expect(calls).toHaveLength(4);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("asks gh for the active login when Settings pin nothing", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("GitHub.com");
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes --user for an account pinned in Settings", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("token-for-work");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a host turned off in Settings without asking gh", () => {
    const { layer, calls } = harness({ "github.com": { enabled: false } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("github.com"));
      expect(error._tag).toBe("GitHubHostDisabledError");
      expect(error.message).toBe(
        "GitHub host github.com is turned off in Settings → Source Control.",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up a changed account on the next request without a restart", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");

      yield* settings.update({
        sourceControlHosts: {
          github: { hosts: { "github.com": { account: "work", enabled: true } } },
        },
      });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("token-for-work");

      yield* settings.update({
        sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
      });
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );

      yield* settings.update({ sourceControlHosts: { github: { hosts: {} } } });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      // The unpinned token stayed cached; only the newly pinned account cost a gh call.
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the active login when the pinned one is no longer signed in", () => {
    const { layer, calls } = harness({ "github.com": { account: "gone" } }, ["gone"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings before GH_TOKEN and gh", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("saved-token");
      expect(credential.source).toBe("settings");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a host turned off even with a token saved in Settings", () => {
    const { layer } = harness({ "github.com": { enabled: false } }, [], {
      "github.com": "saved-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );
    }).pipe(Effect.provide(layer));
  });
});
