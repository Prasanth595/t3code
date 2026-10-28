import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import "../../index.css";

it("keeps the account label and reset summary on a one-account row of a multi-account provider", async () => {
  const now = Date.parse("2026-10-28T01:00:00.000Z");
  const checkedAt = new Date(now).toISOString();
  const driver = ProviderDriverKind.make("codex");
  const presentations: LimitPresentations = new Map([
    [
      EnvironmentId.make("demo"),
      {
        entry: { target: { label: "Demo" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("demo"),
              kind: "cliproxy",
              label: "Demo",
              checkedAt,
              accounts: [
                {
                  id: "session-only",
                  driver,
                  usageLimits: {
                    checkedAt,
                    windows: [
                      {
                        id: "primary",
                        kind: "session",
                        label: "Session",
                        usedPercent: 29,
                        resetsAt: "2026-10-28T03:55:00.000Z",
                      },
                    ],
                  },
                },
                {
                  id: "monthly-only",
                  driver,
                  usageLimits: {
                    checkedAt,
                    windows: [
                      {
                        id: "primary",
                        kind: "monthly",
                        label: "Monthly",
                        usedPercent: 2,
                        resetsAt: "2026-11-26T18:00:00.000Z",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  ]);
  const container = document.createElement("div");
  container.style.width = "1000px";
  await using screen = await render(
    <AppAtomRegistryProvider>
      <UsageLimitsPooled presentations={presentations} now={now} />
    </AppAtomRegistryProvider>,
    { container },
  );
  await expect.element(screen.getByText("monthly-only", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Next account reset in 29d 17h")).toBeVisible();
});
