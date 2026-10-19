import { act } from "react";
import { createRoot } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import "../../index.css";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ unsupported: false }));

vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "Server",
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(["Server"]),
}));
vi.mock("./useScopedSettings", () => ({
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", async () => {
  const { DEFAULT_SERVER_SETTINGS, EnvironmentId } = await import("@t3tools/contracts");
  const { resolveScopedSettingsTargets } = await import("./scopedSettings");
  const { resolveSettingsScope } = await import("./settingsScope");
  return {
    useOptionalSettingsScope: () => {
      if (!state.unsupported) return null;
      const environment = {
        environmentId: EnvironmentId.make("Server"),
        label: "Server",
        connection: { phase: "connected" as const },
        unsupportedSettingKeys: new Set(["reviewGuidesEnabled"]),
        serverConfig: {
          settings: DEFAULT_SERVER_SETTINGS,
          environment: { capabilities: {}, platform: { machine: "server" } },
        },
      };
      const environments = [environment];
      const scope = resolveSettingsScope({}, [], environments);
      return {
        scope,
        environments,
        connectedEnvironments: environments,
        targets: resolveScopedSettingsTargets(scope, environments),
        groups: [],
      };
    },
  };
});

import { scrollToSettingsTarget, SettingsRow } from "./settingsLayout";

const PULSE = "settings-search-target-pulse";

afterEach(() => {
  state.unsupported = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(html: string) {
  document.body.innerHTML = html;
  return vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
}

function reduceMotion(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches } as MediaQueryList);
}

describe("settings search targets", () => {
  it("scrolls a section's header into view, focuses the section, and pulses until blur", () => {
    reduceMotion(false);
    const scrollIntoView = mount(
      `<section id="providers" tabindex="-1"><h2>Providers</h2><p>Body</p></section>`,
    );
    const section = document.getElementById("providers")!;

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(section.querySelector("h2"));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(document.activeElement).toBe(section);
    expect(section.classList.contains(PULSE)).toBe(true);

    section.blur();
    expect(section.classList.contains(PULSE)).toBe(false);
  });

  it("restarts the pulse when the same destination is chosen again", () => {
    reduceMotion(false);
    mount(`<div id="word-wrap" tabindex="-1" class="${PULSE}"></div>`);
    const target = document.getElementById("word-wrap")!;
    const observer = new MutationObserver(() => {});
    observer.observe(target, { attributeFilter: ["class"], attributeOldValue: true });

    scrollToSettingsTarget("word-wrap");
    const previousClasses = observer.takeRecords().map((record) => record.oldValue);
    expect(previousClasses).toEqual([PULSE, ""]);
    expect(target.classList.contains(PULSE)).toBe(true);
  });

  it("does not animate the destination when reduced motion is requested", () => {
    reduceMotion(true);
    const scrollIntoView = mount(`<div id="word-wrap" tabindex="-1"></div>`);
    const target = document.getElementById("word-wrap")!;

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(document.activeElement).toBe(target);
    expect(target.classList.contains(PULSE)).toBe(false);
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});

describe("unavailable settings", () => {
  it("disables unsupported controls, children, and reset while explaining inheritance", async () => {
    state.unsupported = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <SettingsRow
            title="Review guides"
            serverScoped
            settingKeys={["reviewGuidesEnabled"]}
            resetAction={<button>Reset review guides</button>}
            control={<button>Enable review guides</button>}
          >
            <textarea aria-label="Review guide preferences" />
          </SettingsRow>,
        ),
      );
      await expect
        .element(page.getByText("Update T3 Code on Server to use this setting."))
        .toBeVisible();
      const control = container.querySelector<HTMLButtonElement>("button:not([aria-label])")!;
      const editor = container.querySelector("textarea")!;
      control.focus();
      expect(document.activeElement).not.toBe(control);
      editor.focus();
      expect(document.activeElement).not.toBe(editor);
      await expect
        .element(page.getByRole("button", { name: "Reset review guides" }))
        .not.toBeInTheDocument();
      const inheritance = page.getByRole("button", {
        name: /Not supported on Server.*Show where this value comes from/,
      });
      await userEvent.click(inheritance);
      const popup = page.getByText(
        "Not supported. Update T3 Code on this environment to use this setting.",
      );
      await expect.element(popup).toBeVisible();
      const popupText = document.querySelector('[data-slot="popover-popup"]')?.textContent;
      expect(popupText).not.toContain("Inherits");
      expect(popupText).not.toContain("Default");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
