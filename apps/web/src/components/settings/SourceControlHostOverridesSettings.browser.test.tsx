import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const state = vi.hoisted(() => ({
  settings: null as ServerSettings | null,
  canEdit: true,
  save: vi.fn<
    (target: { input: { patch: ServerSettingsPatch } }) => Promise<{ _tag: "Success" }>
  >(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.canEdit) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((
    _environmentId: unknown,
    select: (settings: ServerSettings) => unknown,
  ) => select(state.settings!)) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.save) as never,
}));
vi.mock(import("./settingsLayout"), () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { SourceControlHostOverridesSettings } from "./SourceControlHostOverridesSettings";

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <SourceControlHostOverridesSettings environmentId={EnvironmentId.make("test")} />
      </StrictMode>,
    ),
  );
}

beforeEach(async () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, sourceControlHostOverrides: {} };
  state.canEdit = true;
  state.save.mockReset().mockImplementation(async ({ input }) => {
    state.settings = applyServerSettingsPatch(state.settings!, input.patch);
    await render();
    return { _tag: "Success" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("custom source control hosts", () => {
  it("adds a case-normalized host, edits its provider and base URL, then removes it", async () => {
    await page.getByRole("button", { name: "Add host" }).click();
    await userEvent.fill(page.getByRole("textbox", { name: "Hostname" }), "CODE.Example.TEST");
    await page.getByRole("button", { name: "Save mapping" }).click();
    await expect
      .element(page.getByRole("button", { name: "Edit mapping for code.example.test" }))
      .toBeVisible();
    expect(state.settings!.sourceControlHostOverrides).toEqual({
      "code.example.test": { kind: "forgejo" },
    });

    await page.getByRole("button", { name: "Edit mapping for code.example.test" }).click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "GitLab", exact: true }).click();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Base URL (optional)" }),
      "http://code.example.test:3000/gitlab",
    );
    await page.getByRole("button", { name: "Save mapping" }).click();
    await expect
      .element(page.getByText("code.example.test · GitLab", { exact: true }))
      .toBeVisible();
    expect(state.settings!.sourceControlHostOverrides["code.example.test"]).toEqual({
      kind: "gitlab",
      baseUrl: "http://code.example.test:3000/gitlab",
    });

    await page.getByRole("button", { name: "Remove mapping for code.example.test" }).click();
    await expect
      .element(page.getByRole("button", { name: "Edit mapping for code.example.test" }))
      .not.toBeInTheDocument();
    expect(state.settings!.sourceControlHostOverrides).toEqual({});
  });

  it("rejects invalid hosts, duplicate hosts, and credential-bearing base URLs", async () => {
    state.settings = {
      ...state.settings!,
      sourceControlHostOverrides: { "code.example.test": { kind: "forgejo" } },
    };
    await render();
    await page.getByRole("button", { name: "Add host" }).click();
    const host = page.getByRole("textbox", { name: "Hostname" });
    const save = page.getByRole("button", { name: "Save mapping" });
    await userEvent.fill(host, "https://other.example.test/path");
    await expect.element(save).toBeDisabled();
    await userEvent.fill(host, "CODE.EXAMPLE.TEST");
    await expect.element(save).toBeDisabled();
    await userEvent.fill(host, "other.example.test:3000");
    await userEvent.fill(
      page.getByRole("textbox", { name: "Base URL (optional)" }),
      "https://user:password@other.example.test",
    );
    await expect.element(save).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("renames one mapping without replacing unrelated hosts and clears an omitted base URL", async () => {
    state.settings = {
      ...state.settings!,
      sourceControlHostOverrides: {
        "old.example.test": { kind: "forgejo", baseUrl: "http://old.example.test" },
        "other.example.test": { kind: "github" },
      },
    };
    await render();
    await page.getByRole("button", { name: "Edit mapping for old.example.test" }).click();
    await userEvent.fill(page.getByRole("textbox", { name: "Hostname" }), "new.example.test");
    await userEvent.fill(page.getByRole("textbox", { name: "Base URL (optional)" }), "");
    await page.getByRole("button", { name: "Save mapping" }).click();
    await expect
      .element(page.getByRole("button", { name: "Edit mapping for new.example.test" }))
      .toBeVisible();
    expect(state.settings!.sourceControlHostOverrides).toEqual({
      "new.example.test": { kind: "forgejo" },
      "other.example.test": { kind: "github" },
    });
  });

  it("keeps edits disabled without settings write permission", async () => {
    state.canEdit = false;
    await render();
    await expect.element(page.getByRole("button", { name: "Add host" })).toBeDisabled();
  });
});
