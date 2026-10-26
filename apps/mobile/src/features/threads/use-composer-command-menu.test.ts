import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";

const search = vi.hoisted(() => ({ threadPending: false }));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => () => {} }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
  useThreadSearch: () => ({ isPending: search.threadPending }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  readComposerDraftSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

it("keeps a mention search loading until older threads finish", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  search.threadPending = true;
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    const state = useComposerCommandMenu({
      draftMessage: "@missing",
      ownerKey: null,
      environmentId: EnvironmentId.make("test"),
      projectCwd: "/repo",
      selectedProviderStatus: null,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage: vi.fn(),
    });
    useLayoutEffect(() => {
      menu = state;
    });
    return null;
  }

  act(() => root.render(createElement(Probe)));
  expect(menu).toMatchObject({ items: [], isLoading: true });
  search.threadPending = false;
  act(() => root.render(createElement(Probe)));
  expect(menu).toMatchObject({ items: [], isLoading: false });
});

describe("mobile slash commands", () => {
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
