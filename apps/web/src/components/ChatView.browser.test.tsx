import { createMemoryHistory } from "@tanstack/react-router";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The thread route is code-split; loading ChatView with the file keeps that cost out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const SIDES = {
  claude: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    model: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    search: "Claude",
  },
  codex: {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    model: "gpt-5.4",
    label: "GPT-5.4",
    search: "GPT",
  },
};

/** A thread whose 250k-token context went cold long ago, with its native thread kept for handoff. */
function coldThread(side: (typeof SIDES)[keyof typeof SIDES]) {
  const thread = threadWithHistory(`thread-${side.driver}`, 3, {
    instanceId: side.instanceId,
    model: side.model,
  });
  const updatedAt = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  return {
    ...thread,
    providerThreads: [
      {
        id: ProviderThreadId.make(`provider-thread-${side.driver}`),
        driver: side.driver,
        providerInstanceId: side.instanceId,
        providerSessionId: null,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: side.driver,
          nativeId: `native-${side.driver}`,
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: { usedTokens: 250_000, maxTokens: 1_000_000 },
        nativeMetadata: null,
        goal: null,
        createdAt: updatedAt,
        updatedAt,
      } satisfies OrchestrationV2ProviderThread,
    ],
  };
}

it.each([
  { from: SIDES.claude, to: SIDES.codex, offeredBefore: true },
  { from: SIDES.codex, to: SIDES.claude, offeredBefore: false },
])(
  "sends a $to.label follow-up on a cold $from.label thread without compacting first",
  async ({ from, to, offeredBefore }) => {
    const thread = coldThread(from);
    using environment = installFakeEnvironment([thread], {
      providers: [CLAUDE_PROVIDER, CODEX_PROVIDER],
    });
    await page.viewport(1400, 900);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 1400px;";
    // The app owns its router, as main.tsx does.
    await using _screen = await render(<AppRoot router={router} />, { container, router: false });
    await expect.element(page.getByText(`Answer 2 for ${thread.id}.`)).toBeVisible();
    const compactAndSend = page.getByRole("button", { name: "Compact and send" });
    if (offeredBefore) {
      await expect.element(compactAndSend).toBeVisible();
    }

    await userEvent.click(page.getByRole("button", { name: from.label }));
    await userEvent.type(page.getByPlaceholder("Search models..."), to.search);
    await userEvent.click(page.getByRole("option", { name: to.label, exact: false }));
    await expect.element(page.getByRole("button", { name: to.label })).toBeVisible();
    await expect.element(compactAndSend).not.toBeInTheDocument();

    const editor = page.getByTestId("composer-editor");
    await userEvent.click(editor);
    await userEvent.type(editor, "keep going");
    await userEvent.keyboard("{Enter}");

    const messages = () =>
      environment.dispatchedCommands.flatMap((command) =>
        command.type === "message.dispatch"
          ? [{ text: command.text, instanceId: command.modelSelection?.instanceId }]
          : [],
      );
    const sent = { text: "keep going", instanceId: to.instanceId };
    await vi.waitFor(() => expect(messages()).toContainEqual(sent));
    expect(messages()).toEqual([sent]);
  },
);
