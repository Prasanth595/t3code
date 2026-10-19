import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  providerModelKey,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

describe("model ordering", () => {
  it("groups favorites first while preserving provider model order inside each group", () => {
    const models = [
      { slug: "gpt-5.5" },
      { slug: "gpt-5.4-mini" },
      { slug: "crest-alpha" },
      { slug: "gpt-5.3-codex" },
    ];

    expect(
      sortModelsForProviderInstance(models, {
        favoriteModels: ["gpt-5.5", "gpt-5.4-mini", "crest-alpha"],
        groupFavorites: true,
        modelOrder: ["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"],
      }).map((model) => model.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"]);
  });

  it("uses provider order, then provider model order when no favorite order is supplied", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.4-mini" },
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.5" },
      { instanceId: CODEX_WORK_ID, slug: "crest-alpha" },
      { instanceId: CLAUDE_ID, slug: "claude-opus-4-6" },
    ];
    const favoriteKeys = [
      providerModelKey(CODEX_WORK_ID, "gpt-5.5"),
      providerModelKey(CLAUDE_ID, "claude-opus-4-6"),
      providerModelKey(CODEX_WORK_ID, "gpt-5.4-mini"),
      providerModelKey(CODEX_WORK_ID, "crest-alpha"),
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: favoriteKeys,
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }).map((item) => item.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "claude-opus-4-6"]);
  });

  it("renders favorites in saved order across providers, ignoring unavailable favorites", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "direct-max" },
      { instanceId: CODEX_WORK_ID, slug: "pooled-model" },
      { instanceId: CLAUDE_ID, slug: "pooled-model" },
    ];
    const favoriteModelOrder = [
      providerModelKey(CLAUDE_ID, "pooled-model"),
      providerModelKey(CLAUDE_ID, "unavailable-model"),
      providerModelKey(CODEX_WORK_ID, "pooled-model"),
      providerModelKey(CODEX_WORK_ID, "direct-max"),
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelOrder,
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }),
    ).toEqual([items[2], items[1], items[0]]);
    expect(items.map((item) => item.slug)).toEqual(["direct-max", "pooled-model", "pooled-model"]);
  });

  it("groups favorites in provider tabs without changing their catalog order", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "first" },
      { instanceId: CODEX_WORK_ID, slug: "second" },
      { instanceId: CODEX_WORK_ID, slug: "third" },
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: [
          providerModelKey(CODEX_WORK_ID, "third"),
          providerModelKey(CODEX_WORK_ID, "first"),
        ],
        groupFavorites: true,
      }),
    ).toEqual([items[0], items[2], items[1]]);
  });
});
