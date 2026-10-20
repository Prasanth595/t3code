import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  createProviderVersionAdvisory,
  normalizeCommandPath,
  resolvePackageManagedProviderMaintenance,
  type PackageManagedProviderMaintenanceDefinition,
} from "./maintenanceResolver.ts";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("resolving a proven install must not spawn a process"),
);

const codexLike = {
  provider: ProviderDriverKind.make("codex"),
  npmPackageName: "@openai/codex",
  manualWhenUnproven: true,
  nativeUpdate: {
    args: ["update"],
    isCommandPath: (commandPath: string) =>
      normalizeCommandPath(commandPath).includes("/packages/standalone/"),
  },
} satisfies PackageManagedProviderMaintenanceDefinition;

const resolveInstall = (resolved: string, real = resolved) =>
  resolvePackageManagedProviderMaintenance(codexLike, {
    binaryPath: "codex",
    resolvedCommandPath: resolved,
    realCommandPath: real,
    env: {},
    platform: "linux",
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
  );

it.layer(NodeServices.layer)("manualWhenUnproven", (it) => {
  it.effect("keeps an install no installer is proven for manual-only with its path", () =>
    Effect.gen(function* () {
      const real =
        "/usr/local/lib/codex/releases/rust-v0.162.1-x86_64-unknown-linux-musl-abc123/bin/codex";
      const capabilities = yield* resolveInstall("/usr/local/bin/codex", real);

      expect(capabilities.update).toBeNull();
      expect(capabilities.installPath).toBe(real);
      expect(
        createProviderVersionAdvisory({
          driver: codexLike.provider,
          currentVersion: "0.162.1",
          latestVersion: "0.163.0",
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({
        canUpdate: false,
        updateCommand: null,
        message: expect.stringContaining(real),
      });
    }),
  );

  it.effect.each([
    {
      name: "a standalone install",
      resolved: "/home/me/bin/codex",
      real: "/home/me/.codex/packages/standalone/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex",
      update: { executable: "/home/me/bin/codex", args: ["update"], lockKey: "codex-native" },
    },
    {
      name: "an npm global install",
      resolved: "/opt/node/bin/codex",
      real: "/opt/node/lib/node_modules/@openai/codex/bin/codex.js",
      update: { executable: "npm", lockKey: "npm-global:/opt/node" },
    },
  ] as const)("keeps the updater for $name", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall(fixture.resolved, fixture.real);

      expect(capabilities.update).toMatchObject(fixture.update);
    }),
  );
});
