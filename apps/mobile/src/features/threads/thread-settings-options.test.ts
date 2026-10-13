import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { runtimeModeChoicesForSupportedModes, selectableChoices } from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "medium", label: "Medium", isDefault: true },
    { id: "max", label: "Max" },
    { id: "ultracode", label: "Ultracode" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};

describe("selectableChoices", () => {
  it("offers every option a picker row can store, ultracode included", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "medium",
      "max",
      "ultracode",
    ]);
  });

  it("only offers choices that still read back as selected once stored", () => {
    const capabilities = { optionDescriptors: [effortDescriptor] };
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: [] });
    for (const choice of selectableChoices(effortDescriptor)) {
      const selections = applyProviderOptionSelection(descriptors, {
        id: "effort",
        value: choice.id,
      });
      const [effort] = resolveProviderOptionDescriptors({ capabilities, selections });
      expect(effort?.currentValue).toBe(choice.id);
    }
  });
});

describe("runtimeModeChoicesForSupportedModes", () => {
  it("keeps controls usable when forward-compatible decoding removes every advertised mode", () => {
    expect(runtimeModeChoicesForSupportedModes([])).toHaveLength(4);
  });
});
