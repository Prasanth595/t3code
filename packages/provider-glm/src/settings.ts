import { makeProviderSettingsSchema } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const GlmSettings = makeProviderSettingsSchema(
  {
    ...AcpRegistrySettings.fields,
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    source: Schema.Literal("registry").pipe(
      Schema.withDecodingDefault(Effect.succeed("registry")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    agentId: Schema.Literal("glm-acp-agent").pipe(
      Schema.withDecodingDefault(Effect.succeed("glm-acp-agent")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["commandPath", "authMethodId"] },
);
export type GlmSettings = typeof GlmSettings.Type;
