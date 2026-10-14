import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { makeAcpRegistryAuth } from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const instanceId = ProviderInstanceId.make("acpRegistry_mock");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

/** Signs in to the mock ACP agent over its real stdio wire, like the provider settings row. */
const signIn = (agentEnvironment: Record<string, string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const changed: Array<boolean> = [];
    const controller = yield* makeAcpRegistryAuth({
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
      onChanged: (authenticated) =>
        Effect.sync(() => {
          changed.push(authenticated);
        }),
    }).pipe(
      Effect.provideService(
        AcpRegistrySupport.AcpRegistryCatalog,
        AcpRegistrySupport.AcpRegistryCatalog.of({
          search: () => Effect.die("unused search"),
          prepare: () => Effect.die("unused prepare"),
          uninstallManagedBinary: () => Effect.die("unused uninstall"),
          inspect: () =>
            Effect.succeed({
              status: "ready",
              agentId: "mock-agent",
              version: "1.0.0",
              distribution: "npx",
            }),
          resolve: () =>
            Effect.succeed({
              agent: {
                id: "mock-agent",
                name: "Mock Agent",
                version: "1.0.0",
                description: "ACP sign-in test agent",
                distribution: { npx: { package: "mock-agent@1.0.0" } },
              },
              distribution: "npx" as const,
              spawn: {
                command: "node",
                args: [mockAgentPath],
                env: {
                  ...process.env,
                  T3_ACP_AUTH_METHOD_ID: "mock-login",
                  T3_ACP_REQUIRE_AUTH: "1",
                  ...agentEnvironment,
                },
              },
            }),
        }),
      ),
    );
    const settled = (phase: ProviderAuthState["phase"]) =>
      controller.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === phase || state.phase === "failed"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    yield* controller.subscribe("owner").pipe(
      Stream.filter((state) => (state.methods?.length ?? 0) > 0),
      Stream.runHead,
    );
    yield* controller.start("owner", Effect.void, "mock-login");
    return { changed, settled };
  });

describe("ACP Registry sign-in", () => {
  it.effect("signs in through an agent-handled method and verifies a session", () =>
    Effect.gen(function* () {
      const { changed, settled } = yield* signIn({});
      expect(yield* settled("succeeded")).toMatchObject({
        phase: "succeeded",
        message: "Sign-in complete.",
      });
      expect(changed).toEqual([true]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("names a recognized agent sign-in failure without copying the agent's text", () =>
    Effect.gen(function* () {
      const secret = "https://console.example.test/callback?code=sk-secret-123";
      for (const [agentMessage, message] of [
        [
          "Browser sign-in status could not be retrieved.",
          "The ACP agent could not complete sign-in: Browser sign-in status could not be retrieved.",
        ],
        [
          `Browser sign-in status could not be retrieved. Last poll: ${secret}`,
          "The ACP agent could not complete sign-in: Browser sign-in status could not be retrieved.",
        ],
        [`Sign-in failed at ${secret}`, "The ACP agent could not complete sign-in."],
      ] as const) {
        const { changed, settled } = yield* signIn({
          T3_ACP_AUTHENTICATE_ERROR_MESSAGE: agentMessage,
        });
        const state = yield* settled("succeeded");
        expect(state).toMatchObject({ phase: "failed", message });
        expect(JSON.stringify(state)).not.toContain("sk-secret-123");
        expect(changed).toEqual([]);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
