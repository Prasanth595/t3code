import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { applyClaudeModelPicker, readClaudeModelPicker } from "./ClaudeModelPicker.ts";

const builtIn = (slug: string): ServerProviderModel => ({
  slug,
  name: `Built-in ${slug}`,
  isCustom: false,
  capabilities: createModelCapabilities({ optionDescriptors: [] }),
});
const builtInModels = [builtIn("claude-known"), builtIn("claude-other")];

const writeSettings = Effect.fn(function* (settings: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-picker-" });
  yield* fs.writeFileString(path.join(configDir, "settings.json"), settings);
  return { homePath: configDir };
});

it.layer(NodeServices.layer)("Claude modelPicker", (it) => {
  it.effect("lists picker rows first and keeps bundled models' own controls", () =>
    Effect.gen(function* () {
      const claudeSettings = yield* writeSettings(
        JSON.stringify({
          modelPicker: {
            options: [
              { model: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
              { model: "claude-other", label: "ignored for bundled models" },
              { model: "kimi/kimi-k2.6" },
              { model: "deepseek/deepseek-v4-pro", label: "duplicate" },
              { model: "  " },
              { label: "no model" },
            ],
          },
        }),
      );

      const picker = yield* readClaudeModelPicker(claudeSettings, {});
      const models = applyClaudeModelPicker(builtInModels, picker);

      assert.deepStrictEqual(
        models.map((model) => [model.slug, model.name, model.isCustom]),
        [
          ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", false],
          ["claude-other", "Built-in claude-other", false],
          ["kimi/kimi-k2.6", "kimi/kimi-k2.6", false],
          ["claude-known", "Built-in claude-known", false],
        ],
      );
      assert.strictEqual(models[1], builtInModels[1]);
      assert.isNull(models[0]?.capabilities);
    }),
  );

  it.effect("shows only the picker rows when replaceBuiltInOptions is set", () =>
    Effect.gen(function* () {
      const claudeSettings = yield* writeSettings(
        JSON.stringify({
          modelPicker: {
            replaceBuiltInOptions: true,
            options: [{ model: "kimi/kimi-k2.6", label: "Kimi K2.6" }],
          },
        }),
      );

      const picker = yield* readClaudeModelPicker(claudeSettings, {});

      assert.deepStrictEqual(
        applyClaudeModelPicker(builtInModels, picker).map((model) => model.slug),
        ["kimi/kimi-k2.6"],
      );
    }),
  );

  it.effect("leaves the built-in list alone without a usable modelPicker", () =>
    Effect.gen(function* () {
      const malformed = yield* writeSettings("{ modelPicker: { options: 'nope' }, }");
      const absent = yield* writeSettings("{}");
      const missing = { homePath: `${absent.homePath}/missing` };

      for (const claudeSettings of [malformed, absent, missing]) {
        const picker = yield* readClaudeModelPicker(claudeSettings, {});
        assert.strictEqual(applyClaudeModelPicker(builtInModels, picker), builtInModels);
      }
    }),
  );
});
