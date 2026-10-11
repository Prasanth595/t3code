/**
 * GitHub Copilot instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-copilot/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CopilotSettings = makeProviderSettingsSchema(
  {
    // Off by default (like Grok, Cursor, and OpenCode): users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("copilot").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the GitHub Copilot CLI binary.",
        providerSettingsForm: { placeholder: "copilot", clearWhenEmpty: "omit" },
      }),
    ),
    enterpriseUrl: Schema.optional(Schema.String).pipe(
      Schema.annotateKey({
        title: "Enterprise URI / Host",
        description:
          "The URI or hostname for your GHE.com or GitHub Enterprise Server instance (e.g. https://bmw.ghe.com or https://github.octocat.com). Leave empty for standard GitHub.com.",
        providerSettingsForm: { placeholder: "https://bmw.ghe.com", clearWhenEmpty: "omit" },
      }),
    ),
    enterpriseToken: Schema.optional(Schema.String).pipe(
      Schema.annotateKey({
        title: "Enterprise Token / PAT",
        description:
          "Personal Access Token with Copilot access. If omitted, Copilot uses CLI login (copilot login / gh auth) or stored T3 source control credentials.",
        providerSettingsForm: {
          control: "password",
          secret: true,
          placeholder: "ghp_...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "enterpriseUrl", "enterpriseToken"],
  },
);

export type CopilotSettings = typeof CopilotSettings.Type;
