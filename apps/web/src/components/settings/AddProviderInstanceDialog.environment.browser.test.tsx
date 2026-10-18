import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const actions = vi.hoisted(() => ({
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
}));
const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));
const preparedAgent = vi.hoisted((): AcpRegistrySearchAgent => ({
  id: "kilo",
  name: "Kilo Code",
  version: "4.2.0",
  description: "Kilo ACP agent",
  authors: ["Kilo"],
  license: "Apache-2.0",
  website: null,
  repository: null,
  icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
  distribution: "binary",
  integrity: "sha256",
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: settingsHooks.read as never,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: actions.toast } };
});
// The registry search and the sign-in step talk to the environment over RPC; these
// stand-ins expose the choices a user makes there.
vi.mock(import("./AcpRegistrySearchStep"), async (original) => ({
  ...(await original()),
  AcpRegistrySearchStep: ((props: {
    onPrepared: (agent: AcpRegistrySearchAgent) => void;
    onManualConfiguration: () => void;
    onLocalConfiguration: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onPrepared(preparedAgent)}>
        Use Kilo Code
      </button>
      <button type="button" onClick={props.onManualConfiguration}>
        Enter registry agent
      </button>
      <button type="button" onClick={props.onLocalConfiguration}>
        Use local command
      </button>
    </div>
  )) as never,
}));
vi.mock(import("./ProviderWizardAuthenticationStep"), async (original) => ({
  ...(await original()),
  ProviderWizardAuthenticationStep: (props: {
    environmentId: string;
    instanceId: string;
    onFinish: () => void;
  }) => (
    <section aria-label="Sign-in step">
      {props.environmentId}/{props.instanceId}
      <button type="button" onClick={props.onFinish}>
        Finish sign-in
      </button>
    </section>
  ),
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;

function render(onOpenChange = actions.onOpenChange) {
  return act(async () =>
    root.render(
      <AddProviderInstanceDialog
        open
        environmentId={remoteEnvironmentId}
        environmentLabel="Remote device"
        onOpenChange={onOpenChange}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const click = (label: string) => act(async () => button(label).click());
const selectKimiCode = () =>
  act(async () => {
    const choice = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) =>
      radio.textContent?.includes("Kimi Code"),
    );
    expect(choice).toBeDefined();
    choice!.click();
  });
const input = (selector: string) => {
  const found = document.querySelector<HTMLInputElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};
async function type(selector: string, value: string) {
  await act(async () => userEvent.fill(input(selector), value));
  await act(async () => input(selector).blur());
}
async function selectRegistrySource() {
  const source = document.querySelector<HTMLElement>("#add-provider-acpRegistry-manual-source");
  expect(source).not.toBeNull();
  await act(async () => userEvent.click(source!));
  const registryOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent?.trim() === "ACP Registry",
  );
  expect(registryOption).toBeDefined();
  await act(async () => userEvent.click(registryOption!));
}
const signInStep = () => document.querySelector('[aria-label="Sign-in step"]');

async function prepareCodexInstance() {
  await render();
  await click("Configure manually");
  await type("#add-provider-label", "Work");
  await click("Next");
}

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    actions.canManageProviders = true;
    actions.toast.mockReset();
    actions.onOpenChange.mockReset();
    settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
    settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("creates a provider with its default identity without typing", async () => {
    await render();
    const grok = [...document.querySelectorAll('[role="radio"]')].find((radio) =>
      radio.textContent?.includes("Grok"),
    ) as HTMLElement;
    await act(async () => grok.click());
    await click("Next");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "grok",
      instance: { driver: "grok", enabled: true, displayName: "Grok" },
    });
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_2: { driver: "codex", enabled: false } },
    });
    await render();
    await click("Configure manually");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_3",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Codex",
        config: { setupMode: "existing" },
      },
    });
  });

  it("reads and writes settings through the supplied environment", async () => {
    await render();

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("awaits an atomic create before closing and retains prepared ACP metadata", async () => {
    const mutation = deferred<{ readonly _tag: "Success"; readonly value: unknown }>();
    settingsHooks.mutate.mockReturnValueOnce(mutation.promise);
    await render();
    await selectKimiCode();
    await click("Search registry");
    await click("Use Kilo Code");

    expect(document.body.textContent).toContain("v4.2.0 · binary");
    await click("Continue to sign-in");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_kilo_code",
      instance: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        displayName: "Kilo Code",
        config: {
          agentId: "kilo",
          distribution: "auto",
          registryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
        },
      },
    });
    expect(signInStep()).toBeNull();

    await act(async () => mutation.resolve({ _tag: "Success", value: {} }));
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(signInStep()?.textContent).toContain("remote-device/acpRegistry_kilo_code");
    expect(settingsHooks.mutate).toHaveBeenCalledTimes(1);
    await click("Finish sign-in");
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("configures a manually entered registry agent from the first provider screen", async () => {
    await render();
    await click("Enter registry agent");
    await type("#add-provider-acpRegistry-manual-agentId", "devin");
    await click("Next");
    await click("Continue to sign-in");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_custom",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        config: { agentId: "devin" },
      },
    });
    expect(signInStep()).not.toBeNull();
  });

  it("creates a local command in the selected environment without a sign-in step", async () => {
    await render();
    await click("Use local command");
    await click("Next");
    expect(document.body.textContent).toContain("Executable is required.");
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    await type("#add-provider-acpRegistry-manual-commandPath", "dsh");
    const commandArgs = ["--profile", "acp", " literal $(value) ; ", ""];
    for (const [index, argument] of commandArgs.entries()) {
      await click("Add argument");
      if (argument) await type(`input[aria-label="Argument ${index + 1}"]`, argument);
    }
    await click("Add variable");
    await type('input[aria-label="Environment variable name 1"]', "DSH_PROFILE");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Mark environment variable DSH_PROFILE as sensitive"]',
        )!
        .click(),
    );
    await type('input[aria-label="Environment variable value 1"]', "work");
    await click("Next");
    await type("#add-provider-label", "Deepseek Harness");
    await click("Add instance");

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_deepseek_harness",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Deepseek Harness",
        config: { source: "local", commandPath: "dsh", commandArgs },
        environment: [
          expect.objectContaining({ name: "DSH_PROFILE", value: "work", sensitive: false }),
        ],
      },
    });
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
    expect(signInStep()).toBeNull();
  });

  it("creates Kimi Code through local ACP on the selected environment", async () => {
    await render();
    await selectKimiCode();

    expect(input("#add-provider-acpRegistry-manual-commandPath").value).toBe("kimi");
    expect(input('input[aria-label="Argument 1"]').value).toBe("acp");
    await click("Next");
    await click("Add instance");

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledExactlyOnceWith({
      operation: "create",
      instanceId: "acpRegistry_kimi_code",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Kimi Code",
        config: { source: "local", commandPath: "kimi", commandArgs: ["acp"] },
      },
    });
    expect(signInStep()).toBeNull();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lets Kimi Code use an executable outside the selected environment's PATH", async () => {
    await render();
    await selectKimiCode();
    await type("#add-provider-acpRegistry-manual-commandPath", "/opt/kimi/bin/kimi");
    await click("Next");
    await click("Add instance");

    expect(settingsHooks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({
          config: {
            source: "local",
            commandPath: "/opt/kimi/bin/kimi",
            commandArgs: ["acp"],
          },
        }),
      }),
    );
  });

  it("can reselect Kimi Code after changing the ACP source", async () => {
    await render();
    await selectKimiCode();
    await selectRegistrySource();

    const kimiChoice = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) =>
      radio.textContent?.includes("Kimi Code"),
    );
    expect(kimiChoice?.getAttribute("aria-checked")).toBe("false");
    await selectKimiCode();
    await click("Next");
    await click("Add instance");

    expect(settingsHooks.mutate).toHaveBeenCalledExactlyOnceWith({
      operation: "create",
      instanceId: "acpRegistry_kimi_code",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Kimi Code",
        config: { source: "local", commandPath: "kimi", commandArgs: ["acp"] },
      },
    });
  });

  it.each([
    { label: "Kimi Code", expectedLabel: "" },
    { label: "Work", expectedLabel: "Work" },
  ])(
    "switches Kimi to a registry agent with label '$expectedLabel' after starting with '$label'",
    async ({ label, expectedLabel }) => {
      await render();
      await selectKimiCode();
      await click("Next");
      if (label !== "Kimi Code") await type("#add-provider-label", label);
      await type("#add-provider-instance-id", "registry_work");
      const accentButton = document.querySelector<HTMLElement>(
        `button[aria-label="Add accent color for ${label}"]`,
      );
      expect(accentButton).not.toBeNull();
      await act(async () => userEvent.click(accentButton!));
      await type('input[aria-label="Custom hex accent color"]', "#123456");
      await act(async () => userEvent.keyboard("{Escape}"));
      await click("Back");
      await selectRegistrySource();
      await type("#add-provider-acpRegistry-manual-commandPath", "");
      await type("#add-provider-acpRegistry-manual-agentId", "devin");
      await click("Next");

      expect(input("#add-provider-label").value).toBe(expectedLabel);
      expect(input("#add-provider-instance-id").value).toBe("registry_work");
      await click("Continue to sign-in");

      expect(settingsHooks.mutate).toHaveBeenCalledExactlyOnceWith({
        operation: "create",
        instanceId: "registry_work",
        instance: {
          driver: "acpRegistry",
          enabled: true,
          ...(expectedLabel ? { displayName: expectedLabel } : {}),
          accentColor: "#123456",
          config: { commandArgs: ["acp"], agentId: "devin" },
        },
      });
    },
  );

  it.each(["registry", "local"])(
    "clears the Kimi Code preset when switching to manual %s configuration",
    async (source) => {
      await render();
      await selectKimiCode();
      await click("Search registry");
      if (source === "registry") {
        await click("Enter registry agent");
        await type("#add-provider-acpRegistry-manual-agentId", "devin");
        await click("Next");
        await click("Continue to sign-in");
      } else {
        await click("Use local command");
        const kimiChoice = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
          (radio) => radio.textContent?.includes("Kimi Code"),
        );
        expect(kimiChoice?.getAttribute("aria-checked")).toBe("false");
        expect(input("#add-provider-acpRegistry-manual-commandPath").value).toBe("");
        expect(document.querySelector('input[aria-label="Argument 1"]')).toBeNull();
        await type("#add-provider-acpRegistry-manual-commandPath", "dsh");
        await click("Next");
        await click("Add instance");
      }

      expect(settingsHooks.mutate).toHaveBeenCalledExactlyOnceWith({
        operation: "create",
        instanceId: source === "registry" ? "acpRegistry_custom" : "acpRegistry_local_acp",
        instance: {
          driver: "acpRegistry",
          enabled: true,
          ...(source === "local" ? { displayName: "Local ACP" } : {}),
          config:
            source === "registry"
              ? { agentId: "devin" }
              : { source: "local", commandPath: "dsh", commandArgs: [] },
        },
      });
    },
  );

  it("keeps the dialog open when the atomic upsert fails", async () => {
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    await render();
    await click("Use Kilo Code");
    await click("Continue to sign-in");

    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not add provider instance" }),
    );
    expect(button("Continue to sign-in").disabled).toBe(false);
  });

  it("adds an instance with the selected environment's provider grant alone", async () => {
    await prepareCodexInstance();
    await click("Add instance");

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_work",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Work",
        config: { setupMode: "existing" },
      },
    });
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Provider instance added" }),
    );
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects a queued save after the provider grant is revoked", async () => {
    await prepareCodexInstance();
    const save = button("Add instance");
    actions.canManageProviders = false;
    // The rendered button is still enabled; the click must recheck the live grant.
    await act(async () => save.click());

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    await render();
    expect(button("Add instance").disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", async () => {
    actions.canManageProviders = false;
    await prepareCodexInstance();
    expect(button("Add instance").disabled).toBe(true);
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    await render();
    expect(button("Add instance").disabled).toBe(false);
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });
});
