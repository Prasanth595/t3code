import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  UsageLimitSourceId,
  type UsageLimitSourceAccount,
  type UsageLimitSourceHiddenAccount,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

interface Config {
  readonly environment: { readonly platform: { readonly os: string; readonly arch: string } };
  readonly usageLimitSources: ReadonlyArray<UsageLimitSourceSnapshot>;
}

const state = vi.hoisted(() => ({
  config: null as unknown as Atom.Writable<Config | null>,
  updateHubAccounts: vi.fn(),
  removeHub: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make<Config | null>(null).pipe(Atom.keepAlive);
  state.config = config;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => config) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const commands: Record<string, unknown> = {
    "update hub accounts": state.updateHubAccounts,
    "update Cursor account usage": vi.fn(),
  };
  return {
    ...(await original()),
    useAtomCommand: ((
      command: { readonly label?: string },
      options?: string | { readonly label?: string },
    ) => {
      const label = typeof options === "string" ? options : (options?.label ?? command.label);
      return commands[label ?? ""] ?? vi.fn();
    }) as never,
  };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => state.removeHub) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    description,
    control,
    children,
  }: {
    readonly title: ReactNode;
    readonly description?: ReactNode;
    readonly control?: ReactNode;
    readonly children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
      {children}
    </div>
  )) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { UsageProviderSettings } from "./UsageProviderSettings";

const environmentId = EnvironmentId.make("remote-hub");
const hubId = UsageLimitSourceId.make("hub");
const checkedAt = "2026-10-26T00:00:00.000Z";

const source = (hiddenAccounts: ReadonlyArray<string>) => ({
  kind: "cliproxy" as const,
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
  hiddenAccounts,
});

const visibleAccount = (id: string, email: string): UsageLimitSourceAccount => ({
  id,
  driver: ProviderDriverKind.make("codex"),
  email,
  usageLimits: { checkedAt, windows: [] },
});
const hiddenAccount = (id: string, email: string): UsageLimitSourceHiddenAccount => ({
  id,
  driver: ProviderDriverKind.make("codex"),
  email,
});

interface Options {
  readonly hiddenAccounts: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<UsageLimitSourceAccount>;
  readonly hidden: ReadonlyArray<UsageLimitSourceHiddenAccount>;
}

function settings(options: Options) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsageProviderSettings
        environmentId={environmentId}
        environmentLabel="Remote hub"
        sources={{ [hubId]: source(options.hiddenAccounts) }}
        cursorKeychainUsageEnabled={false}
        readOnly={false}
      />
    </RegistryContext.Provider>
  );
}

async function setup(options: Options) {
  state.updateHubAccounts.mockReset();
  state.removeHub.mockReset();
  const snapshot: UsageLimitSourceSnapshot = {
    id: hubId,
    kind: "cliproxy",
    label: "Hub",
    checkedAt,
    accounts: options.accounts,
    ...(options.hidden.length > 0 ? { hidden: options.hidden } : {}),
  };
  await act(async () =>
    appAtomRegistry.set(state.config, {
      environment: { platform: { os: "linux", arch: "x64" } },
      usageLimitSources: [snapshot],
    }),
  );
}

describe("UsageProviderSettings account visibility", () => {
  it("shows both visible and hidden accounts with their current switch state", async () => {
    const options = {
      hiddenAccounts: ["hidden.json"],
      accounts: [visibleAccount("visible.json", "visible@example.com")],
      hidden: [hiddenAccount("hidden.json", "hidden@example.com")],
    };
    await setup(options);
    await using _screen = await render(settings(options));

    await expect
      .element(page.getByRole("switch", { name: "Show visible@example.com" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("switch", { name: "Show hidden@example.com" }))
      .toHaveAttribute("aria-checked", "false");
    await expect.element(page.getByText("Codex · hidden.json")).toBeVisible();
  });

  it("hides one account, keeping the rest of the hub entry and disabling the hub while saving", async () => {
    const options = {
      hiddenAccounts: ["hidden.json"],
      accounts: [
        visibleAccount("a.json", "a@example.com"),
        visibleAccount("b.json", "b@example.com"),
      ],
      hidden: [hiddenAccount("hidden.json", "hidden@example.com")],
    };
    await setup(options);
    const pending: { resolve?: (value: unknown) => void } = {};
    state.updateHubAccounts.mockReturnValue(
      new Promise((resolve) => {
        pending.resolve = resolve;
      }),
    );
    await using _screen = await render(settings(options));

    await userEvent.click(page.getByRole("switch", { name: "Show a@example.com" }));

    expect(state.updateHubAccounts).toHaveBeenCalledTimes(1);
    expect(state.updateHubAccounts).toHaveBeenCalledWith({
      environmentId,
      input: {
        patch: {
          usageLimitSources: {
            [hubId]: {
              ...source(["hidden.json"]),
              hiddenAccounts: ["hidden.json", "a.json"],
            },
          },
        },
      },
    });
    const switches = ["Show a@example.com", "Show b@example.com", "Show hidden@example.com"];
    for (const name of switches) {
      await expect.element(page.getByRole("switch", { name })).toBeDisabled();
    }

    await act(async () => pending.resolve?.(undefined));

    for (const name of switches) {
      await expect.element(page.getByRole("switch", { name })).toBeEnabled();
    }
  });
});
