// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, type PluginInstallation, PluginInstallationId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentPresentation } from "../../state/environments";

const add = vi.hoisted(() => vi.fn());
const consent = vi.hoisted(() => vi.fn());
const enable = vi.hoisted(() => vi.fn());

vi.mock("../../state/plugins", () => ({
  pluginEnvironment: {
    add: "add",
    consent: "consent",
    enable: "enable",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "consent" ? consent : command === "enable" ? enable : add,
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: true, refresh: vi.fn() }),
}));

import { AddPluginDialog, PluginReviewDialog } from "./PluginsSettings";

const environment = {
  environmentId: EnvironmentId.make("remote"),
  label: "Build box",
  entry: { target: { _tag: "RemoteConnectionTarget" } },
} as unknown as EnvironmentPresentation;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}
async function renderDialog(canManage: boolean) {
  await render(
    <AddPluginDialog
      environment={environment}
      canManage={canManage}
      status={null}
      notice={canManage ? null : "Managing plugins needs administrative access."}
      onClose={() => undefined}
      onAdded={() => undefined}
    />,
  );
}

/** Enters a directory through the input and submits through the live DOM. */
async function typeAndSubmit(canManageAtSubmit: boolean, via: "keyboard" | "button") {
  await renderDialog(true);
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      " /srv/plugins/notifier ",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await renderDialog(canManageAtSubmit);
  await act(async () => {
    if (via === "keyboard")
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    else button("Add and review").click();
  });
}

describe("AddPluginDialog", () => {
  beforeEach(() => {
    add.mockReset().mockReturnValue(new Promise(() => undefined));
  });

  it.each(["keyboard", "button"] as const)(
    "adds the typed directory by %s while management is allowed",
    async (via) => {
      await typeAndSubmit(true, via);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith({
        environmentId: environment.environmentId,
        input: { directory: "/srv/plugins/notifier" },
      });
    },
  );

  it.each(["keyboard", "button"] as const)(
    "sends nothing by %s once the open dialog loses management authority",
    async (via) => {
      await typeAndSubmit(false, via);
      expect(add).not.toHaveBeenCalled();
    },
  );
});

describe("PluginReviewDialog", () => {
  const DIGEST_A = `sha256:${"a".repeat(64)}`;
  const DIGEST_B = `sha256:${"b".repeat(64)}`;
  const reviewed = (digest: string) =>
    ({
      installationId: PluginInstallationId.make("installation-1"),
      directory: "/srv/plugins/notifier",
      manifest: null,
      source: { digest, files: 3, bytes: 2048 },
      problem: null,
      consent: null,
      enabled: false,
    }) as unknown as PluginInstallation;
  const CHECKING = "Checking access…";
  const renderReview = (installation: PluginInstallation, canManage = true) =>
    render(
      <PluginReviewDialog
        environment={environment}
        detail={{ _tag: "found", installation }}
        canManage={canManage}
        status={canManage ? null : CHECKING}
        notice={null}
        npm={null}
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );
  const success = { _tag: "Success", value: { installation: reviewed(DIGEST_A) } };

  beforeEach(() => {
    enable.mockReset().mockResolvedValue(success);
  });

  /** Acknowledges the files on screen, approves, and holds the consent reply. */
  async function approveHoldingConsent() {
    let release: (value: unknown) => void = () => undefined;
    consent.mockReset().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await renderReview(reviewed(DIGEST_A));
    await act(async () => (document.querySelector("[role=checkbox]") as HTMLElement).click());
    await act(async () => button("Approve and enable").click());
    return (value: unknown) => release(value);
  }
  it("enables the reviewed files once consent succeeds", async () => {
    const release = await approveHoldingConsent();
    await renderReview(reviewed(DIGEST_A));
    await act(async () => release(success));
    expect(consent).toHaveBeenCalledWith({
      environmentId: environment.environmentId,
      input: { installationId: "installation-1", digest: DIGEST_A },
    });
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("never enables when the files change while consent is in flight", async () => {
    const release = await approveHoldingConsent();
    // A snapshot reports new bytes for the same installation; access stays granted.
    await renderReview(reviewed(DIGEST_B));
    await act(async () => release(success));
    expect(consent).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
  });
});
