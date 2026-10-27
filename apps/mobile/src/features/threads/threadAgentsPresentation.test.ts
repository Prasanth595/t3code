import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSubagentTraits } from "./threadAgentsPresentation";

const codexInstance = ProviderInstanceId.make("codex");
const claudeInstance = ProviderInstanceId.make("claude");

const codexModel: ServerProviderModel = {
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
      {
        id: "serviceTier",
        label: "Speed",
        type: "select",
        options: [
          { id: "default", label: "Normal" },
          { id: "priority", label: "Fast" },
          { id: "ultra", label: "Ultrafast" },
        ],
      },
    ],
  },
};
const codex = { driver: ProviderDriverKind.make("codex"), models: [codexModel] };

const claude = {
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [
    {
      slug: "claude-test",
      name: "Claude Test",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "max", label: "Max" }],
          },
          { id: "fastMode", label: "Fast", type: "boolean" },
        ],
      },
    },
  ] satisfies ServerProviderModel[],
};

function codexAgent(options: ModelSelection["options"]) {
  return {
    model: "gpt-test",
    providerInstanceId: codexInstance,
    origin: "app_owned" as const,
    modelSelection: { instanceId: codexInstance, model: "gpt-test", options },
  };
}

describe("resolveSubagentTraits", () => {
  it.each([
    ["priority", "fast"],
    ["ultra", "ultrafast"],
    ["default", null],
  ] as const)("shows Codex effort and service tier %s", (tier, speedIcon) => {
    expect(
      resolveSubagentTraits({
        subagent: codexAgent([
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: tier },
        ]),
        provider: codex,
      }),
    ).toEqual({ effort: "High", speedIcon });
  });

  it("shows Claude effort and fast mode", () => {
    expect(
      resolveSubagentTraits({
        subagent: {
          model: "claude-test",
          providerInstanceId: claudeInstance,
          origin: "app_owned",
          modelSelection: {
            instanceId: claudeInstance,
            model: "claude-test",
            options: [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          },
        },
        provider: claude,
      }),
    ).toEqual({ effort: "Max", speedIcon: "fast" });
  });

  it("uses an app-owned child thread's selection when the agent saved none", () => {
    const { modelSelection, ...agent } = codexAgent([{ id: "reasoningEffort", value: "low" }]);
    expect(
      resolveSubagentTraits({
        subagent: agent,
        provider: codex,
        childThread: { providerInstanceId: codexInstance, modelSelection },
      }),
    ).toEqual({ effort: "Low", speedIcon: null });
  });

  it("does not infer an unsaved variant effort", () => {
    expect(
      resolveSubagentTraits({
        subagent: codexAgent([]),
        provider: {
          driver: ProviderDriverKind.make("opencode"),
          models: [
            {
              ...codexModel,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "variant",
                    label: "Effort",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual({ effort: null, speedIcon: null });
  });

  it.each([
    ["no saved selection", { ...codexAgent([]), modelSelection: undefined }, codex],
    ["no saved options", codexAgent([]), codex],
    [
      "no provider catalog",
      codexAgent([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ]),
      undefined,
    ],
    [
      "a selection from another provider instance",
      {
        ...codexAgent([{ id: "reasoningEffort", value: "high" }]),
        providerInstanceId: claudeInstance,
      },
      codex,
    ],
    [
      "a selection for another model",
      {
        ...codexAgent([]),
        modelSelection: {
          instanceId: codexInstance,
          model: "other-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
      codex,
    ],
  ])("shows no labels for %s", (_, subagent, provider) => {
    expect(resolveSubagentTraits({ subagent, provider })).toEqual({
      effort: null,
      speedIcon: null,
    });
  });
});
