import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { modelShortName, withModelShortNames } from "./modelShortName.ts";

describe("modelShortName", () => {
  it.each([
    ["Claude Opus 5.5", "claudeAgent", "Opus 5.5"],
    ["GPT-6.1 Sol", "codex", "6.1 Sol"],
    ["GPT-6.1-Sol", "codex", "6.1-Sol"],
    ["GPT-5.4 Mini", "codex", "5.4 Mini"],
    ["Grok 4 Pro", "grok", "4 Pro"],
    ["Gemini 3.8 Flash", "antigravity", "3.8 Flash"],
    ["Muse Spark 1.3 Contributor", "muse", "Spark 1.3 Contributor"],
  ] as const)("strips %s on its native provider", (name, driver, shortName) => {
    expect(modelShortName(name, driver)).toBe(shortName);
  });

  it.each([
    ["GPT-6.1 Sol", "opencode", "6.1 Sol"],
    ["Claude Opus 5.5", "pi", "Opus 5.5"],
    ["Gemini 4 Argon Contributor", "pi", "4 Argon Contributor"],
  ] as const)(
    "strips %s elsewhere when the rest still names a model",
    (name, driver, shortName) => {
      expect(modelShortName(name, driver)).toBe(shortName);
    },
  );

  it.each([
    ["Grok 4 Pro", "opencode"],
    ["Gemini 3.8 Flash", "cursor"],
    ["GPT-5.4 Mini", "pi"],
    ["Gemini 3.1 Pro (High)", "opencode"],
  ] as const)("keeps %s whole off its native provider when only a tier remains", (name, driver) => {
    expect(modelShortName(name, driver)).toBeUndefined();
  });

  it.each([
    ["Grok 5", "grok"],
    ["Grok 5", "opencode"],
    ["GPT-5.5", "codex"],
    ["Gemini 3 (High)", "antigravity"],
  ] as const)("never reduces %s on %s to a bare version", (name, driver) => {
    expect(modelShortName(name, driver)).toBeUndefined();
  });

  it("keeps parenthetical suffixes", () => {
    expect(modelShortName("Gemini 3.8 Flash (High)", "antigravity")).toBe("3.8 Flash (High)");
  });

  it("leaves names outside the family table alone", () => {
    expect(modelShortName("Big Pickle", "opencode")).toBeUndefined();
    expect(modelShortName("gpt-5.5", "opencode")).toBeUndefined();
  });
});

describe("withModelShortNames", () => {
  const model = (input: Partial<ServerProviderModel> & { name: string }): ServerProviderModel => ({
    slug: input.name.toLowerCase().replaceAll(" ", "-"),
    isCustom: false,
    capabilities: null,
    ...input,
  });
  const provider = (models: ReadonlyArray<ServerProviderModel>): ServerProvider => ({
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "3.0.0",
    status: "ready",
    checkedAt: "2026-10-23T00:00:00Z",
    auth: { status: "authenticated" },
    models,
    skills: [],
    slashCommands: [],
  });

  it("fills custom models and keeps an explicit shortName", () => {
    const result = withModelShortNames(
      provider([
        model({ name: "Claude Opus 5.5", shortName: "Opus" }),
        model({ name: "Claude Sonnet 6", isCustom: true }),
      ]),
    );
    expect(result.models.map((entry) => entry.shortName)).toEqual(["Opus", "Sonnet 6"]);
  });

  it("returns the same snapshot when nothing shortens", () => {
    const snapshot = provider([model({ name: "Claude 5" })]);
    expect(withModelShortNames(snapshot)).toBe(snapshot);
  });
});
