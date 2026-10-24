import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

const refreshProviders = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  readComposerDraftSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => refreshProviders,
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  it.each([false, true])("offers /btw only when the composer can ask=%s", (offersSideQuestion) => {
    const items = buildComposerSlashCommandItems({
      query: "btw",
      atMessageStart: true,
      hasThread: true,
      offersSideQuestion,
      allowInteractionMode: false,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("claude"),
        slashCommands: [{ name: "btw" }],
      },
    });
    expect(items.map((item) => item.label)).toEqual(offersSideQuestion ? ["/btw"] : []);
  });

  it("offers /btw from the live session when the draft provider lacks it", () => {
    const items = buildComposerSlashCommandItems({
      query: "btw",
      atMessageStart: true,
      hasThread: true,
      offersSideQuestion: true,
      allowInteractionMode: false,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    expect(items.map((item) => item.label)).toEqual(["/btw"]);
  });

  it.each([1, 2, 3, 4])("consumes the full /btw token with the caret at %s", (rangeEnd) => {
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/btw what changed?",
        trigger: { rangeStart: 0, rangeEnd },
        item: {
          id: "pcmd:btw",
          type: "provider-slash-command",
          command: { name: "btw" },
          label: "/btw",
          description: "Ask a side question",
        },
        allowInteractionMode: false,
      }),
    ).toEqual({ text: " what changed?", cursor: 0, interactionMode: null });
  });

  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});
