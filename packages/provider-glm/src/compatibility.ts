import {
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GlmSettings } from "./settings.ts";

const acpRegistryDriver = ProviderDriverKind.make("acpRegistry");
const glmDriver = ProviderDriverKind.make("glm");
const isConfigRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const decodeGlmSettings = Schema.decodeUnknownOption(GlmSettings);
const isGlmRegistryConfig = Schema.is(
  Schema.Struct({
    agentId: Schema.Literal("glm-acp-agent"),
    source: Schema.optionalKey(Schema.Literal("registry")),
  }),
);

export function migrateGlmProviderInstances(
  instances: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  let migrated: Record<string, ProviderInstanceConfig> | undefined;
  for (const [instanceId, instance] of Object.entries(instances)) {
    let next = instance;
    if (instance.driver === acpRegistryDriver && isGlmRegistryConfig(instance.config)) {
      next = { ...instance, driver: glmDriver };
    }
    if (next.driver === glmDriver) {
      const config = next.config === undefined ? {} : next.config;
      if (
        isConfigRecord(config) &&
        (config.source === undefined || config.agentId === undefined) &&
        Option.isSome(decodeGlmSettings(config))
      ) {
        next = { ...next, config: { ...config, source: "registry", agentId: "glm-acp-agent" } };
      }
    }
    if (next === instance) continue;
    migrated ??= { ...instances };
    migrated[instanceId] = next;
  }
  return migrated ?? instances;
}
