import { describe, expect, it } from "@effect/vitest";
import {
  type ProviderInstanceConfigMap,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { migrateGlmProviderInstances } from "./compatibility.ts";

describe("GLM provider compatibility", () => {
  it("preserves the complete instance envelope and config when changing the registry driver", () => {
    const instance = {
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Work GLM",
      accentColor: "#123456",
      enabled: false,
      environment: [{ name: "Z_AI_API_KEY", value: "test-key", sensitive: true }],
      config: {
        agentId: "glm-acp-agent",
        source: "registry",
        commandPath: "/opt/local/bin/glm-acp",
        commandArgs: ["--verbose"],
        distribution: "binary",
        authMethodId: "work-account",
        customModels: ["glm-5.1"],
      },
    };
    const instanceId = ProviderInstanceId.make("acpRegistry_glm_work");
    const instances = { [instanceId]: instance };
    const migrated = migrateGlmProviderInstances(instances);

    expect(migrated).toEqual({
      acpRegistry_glm_work: { ...instance, driver: "glm" },
    });
    expect(migrated[instanceId]?.config).toBe(instance.config);
    expect(migrated[instanceId]?.environment).toBe(instance.environment);
    expect(instance.driver).toBe("acpRegistry");
    expect(migrateGlmProviderInstances(migrated)).toBe(migrated);
  });

  it("accepts registry configs saved before source was explicit", () => {
    const instanceId = ProviderInstanceId.make("old_glm");
    expect(
      migrateGlmProviderInstances({
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { agentId: "glm-acp-agent" },
        },
      })[instanceId]?.driver,
    ).toBe("glm");
  });

  it.each([undefined, {}, { commandPath: "/opt/local/bin/glm-acp", customModels: ["glm-5.1"] }])(
    "persists registry identity defaults for explicit GLM configs: %j",
    (config) => {
      const instanceId = ProviderInstanceId.make("glm_work");
      const instances = { [instanceId]: { driver: ProviderDriverKind.make("glm"), config } };
      const migrated = migrateGlmProviderInstances(instances);
      expect(migrated[instanceId]?.config).toEqual({
        ...config,
        source: "registry",
        agentId: "glm-acp-agent",
      });
      expect(migrateGlmProviderInstances(migrated)).toBe(migrated);
    },
  );

  it.each([null, [], "glm", { source: "local" }, { agentId: "kilo" }, { commandArgs: false }])(
    "leaves invalid GLM configs for driver validation: %j",
    (config) => {
      const instanceId = ProviderInstanceId.make("glm_work");
      const instances = { [instanceId]: { driver: ProviderDriverKind.make("glm"), config } };
      expect(migrateGlmProviderInstances(instances)).toBe(instances);
    },
  );

  it.each([
    undefined,
    null,
    [],
    "glm-acp-agent",
    { agentId: "glm-acp-agent", source: "local" },
    { agentId: "glm-acp-agent", source: "custom" },
    { agentId: "glm-acp-agent", source: null },
    { agentId: "kilo", source: "registry" },
    { source: "registry" },
  ])("leaves unrelated, local, and invalid configs unchanged: %j", (config) => {
    const instances = {
      other: { driver: ProviderDriverKind.make("acpRegistry"), config },
    };
    expect(migrateGlmProviderInstances(instances)).toBe(instances);
  });

  it("leaves other drivers unchanged even if their config names the GLM agent", () => {
    const instanceId = ProviderInstanceId.make("other");
    const instances: ProviderInstanceConfigMap = {
      [instanceId]: {
        driver: ProviderDriverKind.make("custom"),
        config: { agentId: "glm-acp-agent", source: "registry" },
      },
    };
    expect(migrateGlmProviderInstances(instances)).toBe(instances);
  });
});
