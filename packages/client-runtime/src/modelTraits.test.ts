import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

describe("thinking trait label", () => {
  const display = (descriptors: ProviderOptionDescriptor[]) =>
    buildTraitsTriggerDisplay({
      provider: ProviderDriverKind.make("claudeAgent"),
      descriptors,
      primarySelectDescriptorId: "effort",
      ultrathinkPromptControlled: false,
    }).label;

  it("keeps default thinking out of the normal effort and context label", () => {
    expect(
      display([
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
        },
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        {
          id: "contextWindow",
          label: "Context Window",
          type: "select",
          options: [{ id: "200k", label: "200k", isDefault: true }],
        },
      ]),
    ).toBe("High · 200k");
  });

  it("keeps a visible label when thinking is the only control", () => {
    expect(
      display([{ id: "thinking", label: "Thinking", type: "boolean", currentValue: true }]),
    ).toBe("Thinking");
  });

  it("shows an explicit thinking-off choice", () => {
    expect(
      display([{ id: "thinking", label: "Thinking", type: "boolean", currentValue: false }]),
    ).toBe("Thinking Off");
  });
});
