import { describe, expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

function snapshot(id: string, driver: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-29T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("next prompt text generation routing", () => {
  it.effect("uses the normal fallback when the selected provider has exhausted its allowance", () =>
    Effect.gen(function* () {
      const selected = snapshot("codex", "codex");
      const fallback = snapshot("claudeAgent", "claudeAgent");
      const generateSelected = vi.fn(() => Effect.succeed({ suggestion: "Selected" }));
      const generateFallback = vi.fn(() => Effect.succeed({ suggestion: "Fallback" }));
      const instances = [selected, fallback].map(
        (provider, index) =>
          ({
            instanceId: provider.instanceId,
            snapshot: {
              getSnapshot: Effect.succeed(
                index === 0
                  ? {
                      ...provider,
                      usageLimits: {
                        checkedAt: provider.checkedAt,
                        windows: [
                          {
                            id: "session",
                            label: "Session",
                            kind: "session",
                            usedPercent: 100,
                            resetsAt: null,
                          },
                        ],
                      },
                    }
                  : provider,
              ),
            },
            textGeneration: {
              generateNextPrompt: index === 0 ? generateSelected : generateFallback,
            },
          }) as unknown as ProviderInstance,
      );
      const layer = Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed(instances),
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("unused"),
        }),
        ServerSettings.layerTest({
          providerInstances: {
            [selected.instanceId]: { driver: selected.driver, enabled: true, config: {} },
            [fallback.instanceId]: { driver: fallback.driver, enabled: true, config: {} },
          },
        }),
      );
      const service = yield* TextGeneration.make.pipe(Effect.provide(layer));
      const result = yield* service.generateNextPrompt({
        cwd: "/repo",
        message: "User: hello",
        instructions: "Keep it short",
        modelSelection: { instanceId: selected.instanceId, model: "gpt-6.1-sol" },
      });
      expect(result).toEqual({ suggestion: "Fallback" });
      expect(generateSelected).not.toHaveBeenCalled();
      expect(generateFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: "Keep it short",
          modelSelection: expect.objectContaining({ instanceId: fallback.instanceId }),
        }),
      );
    }),
  );
});
