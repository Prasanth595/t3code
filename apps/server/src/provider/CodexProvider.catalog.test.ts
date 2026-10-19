import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { checkCodexProviderStatus } from "./CodexProvider.ts";

/**
 * Stand-in for Codex 0.162's app-server catalog behavior:
 * - `model/list` answers from `CODEX_HOME/models_cache.json` while it is fresh.
 * - A startup refresh runs before `initialize`, so it uses the originator set
 *   at spawn (the override env var, else the plain CLI's `codex_cli_rs`).
 * - The backend grants Ultrafast only to entitled accounts on app originators.
 */
const FAKE_CODEX_APP_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const cachePath = path.join(process.env.CODEX_HOME, "models_cache.json");
const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "codex_cli_rs";
const ultrafast = process.env.FAKE_ULTRAFAST_ENTITLED === "1" && originator !== "codex_cli_rs";
const model = (tiers) => ({
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  serviceTiers: tiers.map((id) => ({ id, name: id, description: "" })),
});
setTimeout(() => {
  const tiers = ultrafast ? ["priority", "ultrafast"] : ["priority"];
  fs.writeFileSync(cachePath, JSON.stringify({ fetched_at: new Date().toISOString(), models: [model(tiers)] }));
}, 300);
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.162.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
  } else if (method === "account/read") {
    write({ id, result: { account: { type: "chatgpt", email: "test@example.com", planType: "promax" }, requiresOpenaiAuth: false } });
  } else if (method === "skills/list") {
    write({ id, result: { data: [] } });
  } else if (method === "model/list") {
    write({ id, result: { data: JSON.parse(fs.readFileSync(cachePath, "utf8")).models, nextCursor: null } });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const codexProviderSnapshot = Effect.fn("codexProviderSnapshot")(function* (
  ultrafastEntitled: boolean,
  customModels: CodexSettings["customModels"] = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
  const binaryPath = path.join(dir, "codex");
  yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
  yield* fs.chmod(binaryPath, 0o755);

  yield* fs.writeFileString(
    path.join(dir, "models_cache.json"),
    JSON.stringify({
      fetched_at: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      models: [
        {
          id: "gpt-6.1-sol",
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          description: "",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
          serviceTiers: (ultrafastEntitled ? ["priority"] : ["priority", "ultrafast"]).map(
            (id) => ({ id, name: id, description: "" }),
          ),
        },
      ],
    }),
  );

  const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
  return yield* checkCodexProviderStatus(
    decodeCodexSettings({ binaryPath, homePath: dir, customModels }),
    undefined,
    { ...environment, FAKE_ULTRAFAST_ENTITLED: ultrafastEntitled ? "1" : "0" },
  );
});

const solServiceTiers = Effect.fn("solServiceTiers")(function* (ultrafastEntitled: boolean) {
  const provider = yield* codexProviderSnapshot(ultrafastEntitled);
  const serviceTier = provider.models
    .find((model) => model.slug === "gpt-6.1-sol")
    ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier");
  return serviceTier?.type === "select" ? serviceTier.options.map((option) => option.id) : [];
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex catalog discovery", (it) => {
  it.effect("keeps Ultrafast when another Codex client wrote the shared catalog cache", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(true), ["default", "priority", "ultrafast"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps bare custom model effort unknown while preserving selectable and authored effort",
    () =>
      Effect.gen(function* () {
        const authoredCapabilities = {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "low",
              options: [{ id: "low", label: "Low", isDefault: true }],
            },
          ],
        } as const;
        const provider = yield* codexProviderSnapshot(false, [
          "custom-bare",
          { slug: "custom-authored", name: "Authored", capabilities: authoredCapabilities },
        ]);
        const builtin = provider.models.find((model) => model.slug === "gpt-6.1-sol");
        const bare = provider.models.find((model) => model.slug === "custom-bare");
        const authored = provider.models.find((model) => model.slug === "custom-authored");
        const builtinEffort = builtin?.capabilities?.optionDescriptors?.find(
          (option) => option.id === "reasoningEffort",
        );
        const bareEffort = bare?.capabilities?.optionDescriptors?.find(
          (option) => option.id === "reasoningEffort",
        );
        assert.equal(getProviderOptionCurrentValue(builtinEffort), "high");
        assert.isTrue(bare?.isCustom);
        assert.equal(bareEffort?.type, "select");
        assert.deepStrictEqual(
          bareEffort?.type === "select" ? bareEffort.options.map((option) => option.id) : [],
          ["high"],
        );
        assert.deepStrictEqual(authored?.capabilities, authoredCapabilities);

        const input = {
          nativeThreadId: "custom-model-thread",
          codexInput: [{ type: "text", text: "work" }],
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          models: provider.models,
          hasT3Mcp: true,
        } as const;
        const selection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "custom-bare",
        };
        const explicit = yield* buildCodexTurnStartParams({
          ...input,
          modelSelection: {
            ...selection,
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        });
        assert.equal(explicit.effort, "high");
        assert.equal(explicit.collaborationMode?.settings.reasoning_effort, "high");
        const authoredDefault = yield* buildCodexTurnStartParams({
          ...input,
          modelSelection: { ...selection, model: "custom-authored" },
        });
        assert.equal(authoredDefault.effort, "low");
        assert.equal(authoredDefault.collaborationMode?.settings.reasoning_effort, "low");

        const omitted = yield* buildCodexTurnStartParams({
          ...input,
          modelSelection: selection,
        });
        assert.isUndefined(omitted.effort);
        assert.isNull(omitted.collaborationMode?.settings.reasoning_effort);
        assert.notInclude(
          omitted.additionalContext?.t3_code_runtime?.value ?? "",
          "reasoning effort",
        );
        assert.isUndefined(bareEffort?.currentValue);
        assert.isUndefined(getProviderOptionCurrentValue(bareEffort));
      }).pipe(Effect.scoped),
  );

  it.effect("drops Ultrafast once the account is no longer entitled to it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* solServiceTiers(false), ["default", "priority"]);
    }).pipe(Effect.scoped),
  );
});
