import "../../index.css";

import {
  EnvironmentId,
  type OrchestrationV2ProviderFailureClass,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { useChatWarningDismissals, useChatWarnings } from "../../chatWarningDismissals";

import {
  ChatWarningIndicator,
  resolveProviderChatWarning,
  resolveThreadErrorChatWarning,
  type ChatWarning,
} from "./ChatWarningIndicator";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("combines exact warning reasons, opens the affected provider setup, and updates severity as errors clear", async () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("google-work"),
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "Work Google account",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "error",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "SUBSCRIPTION_REQUIRED: This Google account cannot use Antigravity.",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const environmentId = EnvironmentId.make("remote");
  const onOpenProviderSetup = vi.fn();
  const render = (warnings: ReadonlyArray<ChatWarning | null>, canDismissForNow = true) =>
    act(async () =>
      root.render(
        <ChatWarningIndicator
          warnings={warnings.filter((warning): warning is ChatWarning => warning !== null)}
          canDismissForNow={canDismissForNow}
          onDismissForNow={vi.fn()}
          onDismissForever={vi.fn()}
          onOpenProviderSetup={onOpenProviderSetup}
        />,
      ),
    );
  const threadWarning = resolveThreadErrorChatWarning(
    "remote:thread-a",
    "Usage limit reached.\nRetry after 14:00 UTC.",
    "usage_limit",
  );
  await render([resolveProviderChatWarning(environmentId, provider), threadWarning]);

  const trigger = page.getByRole("button", { name: "2 warnings", exact: true });
  await expect.element(trigger).toBeVisible();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(/SUBSCRIPTION_REQUIRED: This Google account cannot use Antigravity\./);
  await expect.element(page.getByRole("alert")).toMatchTextContent(/Retry after 14:00 UTC\./);
  await userEvent.click(trigger);

  const popup = page.getByRole("dialog");
  await expect.element(popup).toHaveAttribute("data-variant", "error");
  await expect
    .element(popup)
    .toMatchTextContent(/SUBSCRIPTION_REQUIRED: This Google account cannot use Antigravity\./);
  await expect.element(popup).toMatchTextContent(/Usage limit reached\./);
  await expect.element(page.getByRole("button", { name: "Dismiss all for now" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Don't show these again" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Open provider setup" }));
  expect(onOpenProviderSetup).toHaveBeenCalledExactlyOnceWith(provider.instanceId);

  await render([
    resolveProviderChatWarning(environmentId, {
      ...provider,
      status: "warning",
      auth: { status: "authenticated" },
      message: "Limited functionality.",
    }),
    threadWarning,
  ]);
  await expect.element(popup).toHaveAttribute("data-variant", "warning");
  await expect.element(popup).toMatchTextContent(/Limited functionality\./);
  await expect
    .element(popup)
    .not.toMatchTextContent(/SUBSCRIPTION_REQUIRED: This Google account cannot use Antigravity\./);

  await render([threadWarning], false);
  await expect.element(page.getByRole("button", { name: "1 warning", exact: true })).toBeVisible();
  await expect.element(popup).toHaveAttribute("data-variant", "warning");
  await expect
    .element(page.getByRole("button", { name: "Dismiss for now" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Don't show again" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Open provider setup" }))
    .not.toBeInTheDocument();

  await render([]);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(popup).not.toBeInTheDocument();
  expect(container.querySelector("button")).toBeNull();
});

it("keeps exact dismissals through remounts and reconnects, scoped to the environment and server run", async () => {
  const environmentId = EnvironmentId.make("remote");
  const otherEnvironmentId = EnvironmentId.make("other");
  let dismissals!: ReturnType<typeof useChatWarningDismissals>;
  function Probe({
    environment = environmentId,
    run = "run-a",
    thread = "thread-a",
    reason = "Turn failed",
    failureClass = null,
  }: {
    environment?: EnvironmentId;
    run?: string | null;
    thread?: string;
    reason?: string;
    failureClass?: OrchestrationV2ProviderFailureClass | null;
  }) {
    const store = useChatWarningDismissals();
    useEffect(() => {
      dismissals = store;
    });
    const { warnings, dismissForNow, dismissForever } = useChatWarnings(
      [resolveThreadErrorChatWarning(`${environment}:${thread}`, reason, failureClass)],
      environment,
      run,
    );
    return (
      <ChatWarningIndicator
        warnings={warnings}
        canDismissForNow={run !== null}
        onDismissForNow={dismissForNow}
        onDismissForever={dismissForever}
        onOpenProviderSetup={vi.fn()}
      />
    );
  }
  const trigger = page.getByRole("button", { name: "1 warning", exact: true });
  const render = (props: Parameters<typeof Probe>[0] = {}) =>
    act(async () => root.render(<Probe {...props} />));
  await render();
  await act(() => dismissals[1]({ temporary: [], permanent: [] }));
  try {
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("button", { name: "Dismiss for now", exact: true }));
    await expect.element(trigger).not.toBeInTheDocument();
    await act(async () => root.render(null));
    await render({ run: null });
    await expect.element(trigger).not.toBeInTheDocument();

    // Before ready, only exact warnings from the last known run stay hidden.
    for (const props of [
      { environment: otherEnvironmentId },
      { thread: "thread-b" },
      { reason: "A different failure" },
      { failureClass: "usage_limit" as const },
    ]) {
      await render({ ...props, run: null });
      await expect.element(trigger).toBeVisible();
    }
    await userEvent.click(trigger);
    await expect
      .element(page.getByRole("button", { name: "Dismiss for now", exact: true }))
      .not.toBeInTheDocument();
    await render({ run: null });
    await expect.element(trigger).not.toBeInTheDocument();

    // A replay preserves dismissal; a new ready resurfaces it, even on the next reload.
    await render({ run: "run-a" });
    await expect.element(trigger).not.toBeInTheDocument();
    await render({ run: "run-b" });
    await expect.element(trigger).toBeVisible();
    await act(async () => root.render(null));
    await render({ run: null });
    await expect.element(trigger).toBeVisible();
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("button", { name: "Don't show again", exact: true }));
    await expect.element(trigger).not.toBeInTheDocument();
    await act(async () => root.render(null));
    await render({ run: "run-c" });
    await expect.element(trigger).not.toBeInTheDocument();

    // A dismissal on a different environment must not prune this run's temporary IDs.
    await render({ environment: otherEnvironmentId });
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("button", { name: "Dismiss for now", exact: true }));
    await render({ reason: "A new failure", run: "run-b" });
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("button", { name: "Dismiss for now", exact: true }));
    expect(dismissals[0].temporary.some((id) => id.startsWith("other\u0000run-a\u0000"))).toBe(
      true,
    );
    expect(dismissals[0].temporary.some((id) => id.startsWith("remote\u0000run-a\u0000"))).toBe(
      false,
    );
  } finally {
    await act(() => dismissals[1]({ temporary: [], permanent: [] }));
  }
});
