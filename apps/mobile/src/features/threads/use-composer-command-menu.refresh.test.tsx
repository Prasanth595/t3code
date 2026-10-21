import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const refreshProviders = vi.hoisted(() => vi.fn());
vi.mock("../../components/ui/Dialog", () => ({}));
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
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: Symbol() } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => refreshProviders }));

import { useComposerCommandMenu } from "./use-composer-command-menu";

it("recovers a newly installed skill after discovery returns an expired complete fallback", async () => {
  const cwd = "/project";
  let now = Date.parse("2026-10-20T12:00:00Z");
  using _clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const expired: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(now).toISOString(),
    models: [],
    skills: [],
    slashCommands: [],
    workspaceSnapshots: [
      {
        cwd,
        checkedAt: new Date(now - 300_001).toISOString(),
        skills: [],
        slashCommands: [],
      },
    ],
  };
  const recovered: ServerProvider = {
    ...expired,
    workspaceSnapshots: [
      {
        cwd,
        checkedAt: new Date(now + 10_001).toISOString(),
        skills: [{ name: "recovered", path: "/project/SKILL.md", enabled: true }],
        slashCommands: [],
      },
    ],
  };
  let provider = expired;
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  refreshProviders
    .mockReset()
    .mockImplementationOnce(async () => AsyncResult.success({ providers: [expired] }))
    .mockImplementation(async () => {
      provider = recovered;
      return AsyncResult.success({ providers: [recovered] });
    });
  function Consumer({ draft }: { draft: string }) {
    const currentMenu = useComposerCommandMenu({
      draftMessage: draft,
      ownerKey: null,
      environmentId: EnvironmentId.make("local"),
      projectCwd: cwd,
      selectedProviderStatus: provider,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage: () => {},
    });
    useEffect(() => {
      menu = currentMenu;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Consumer draft="/rec" />));
    expect(provider.workspaceSnapshots?.[0]?.skills).toEqual([]);
    now += 10_001;
    await act(async () => root.render(<Consumer draft="/reco" />));
    await act(async () => root.render(<Consumer draft="/recovered" />));
    expect(menu?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "skill",
          skill: expect.objectContaining({ name: "recovered" }),
        }),
      ]),
    );
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
