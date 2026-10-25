import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { barColor, LimitWindows } from "./UsageLimits";

vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  usePrimarySettings: <T,>(select: (settings: { timestampFormat: "locale" }) => T) =>
    select({ timestampFormat: "locale" }),
}));

const driver = ProviderDriverKind.make("claudeAgent");
const windows: ServerProviderUsageWindow[] = [
  { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
];

// The browser serializes a hex colour as rgb(), so both sides go through the same parser.
function cssColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  return probe.style.backgroundColor;
}

async function fillColor(accentColor: string | undefined): Promise<string | undefined> {
  await using screen = await render(
    <LimitWindows compact driver={driver} accentColor={accentColor} windows={windows} now={0} />,
  );
  return screen.container.querySelector<HTMLElement>('[role="img"] [style*="width: 60%"]')?.style
    .backgroundColor;
}

describe("LimitWindows accent colour", () => {
  it("fills the bar with the account accent", async () => {
    expect(await fillColor("#2563eb")).toBe(cssColor("#2563eb"));
  });

  it.each([undefined, "blue", "#2563e"])(
    "falls back to the provider colour for %s",
    async (accent) => {
      expect(await fillColor(accent)).toBe(cssColor(barColor(driver)));
    },
  );
});
