// @effect-diagnostics nodeBuiltinImport:off -- Models Node's failed-spawn child and its next-tick error.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { loadPluginDirectory } from "./PluginManifestLoader.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof NodeChildProcess>()),
  spawn: vi.fn(),
}));

it.layer(NodeServices.layer)("PluginSupervisor failed spawn", (it) => {
  it.effect.each(["EMFILE", "ENFILE"])(
    "supervises %s without stdio before Node emits error",
    (code) =>
      Effect.gen(function* () {
        const child = Object.assign(new NodeEvents.EventEmitter(), {
          pid: undefined,
          stdio: undefined,
          kill: vi.fn(),
        });
        vi.mocked(NodeChildProcess.spawn).mockReturnValueOnce(
          child as unknown as ReturnType<typeof NodeChildProcess.spawn>,
        );
        const supervisor = yield* PluginSupervisor.make().pipe(
          Effect.provideService(HostProcess.Arguments, [
            process.execPath,
            `${import.meta.dirname}/../bin.ts`,
          ]),
        );
        const registration = yield* loadPluginDirectory(
          `${import.meta.dirname}/testFixtures/plugin`,
        );
        yield* supervisor.enable(registration);
        const outcome = yield* supervisor
          .invoke(registration.manifest.id, "ping", null)
          .pipe(Effect.flip);
        expect(outcome._tag).toBe("PluginUnavailableError");
        expect(child.listenerCount("error")).toBeGreaterThan(0);
        child.emit("error", Object.assign(new Error(`spawn ${code}`), { code }));
        expect(child.kill).not.toHaveBeenCalled();
        yield* supervisor.disable(registration.manifest.id);
      }),
  );
});
