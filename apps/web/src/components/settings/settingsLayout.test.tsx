// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
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

import { scrollToSettingsTarget, SettingsRow, SettingsUnavailableGroup } from "./settingsLayout";

afterEach(() => {
  state.unsupported = false;
  vi.unstubAllGlobals();
});

describe("unavailable settings", () => {
  it("disables an unsupported row and explains support in its inheritance popover", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
            control={<button>Enable review guides</button>}
          >
            <textarea aria-label="Review guide preferences" />
          </SettingsRow>,
        ),
      );
      expect(container.textContent).toContain("Update T3 Code on Server to use this setting.");
      expect(container.querySelector("textarea")?.closest("[inert]")).not.toBeNull();
      const control = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Enable review guides",
      );
      expect(control?.closest("[inert]")).not.toBeNull();
      const inheritance = container.querySelector<HTMLButtonElement>(
        'button[aria-label*="Show where this value comes from"]',
      );
      expect(inheritance?.getAttribute("aria-label")).toContain("Not supported on Server");
      await act(async () => inheritance!.click());
      const popup = document.querySelector('[data-slot="popover-popup"]');
      expect(popup?.textContent).toContain(
        "Not supported. Update T3 Code on this environment to use this setting.",
      );
      expect(popup?.textContent).not.toContain("Inherits");
      expect(popup?.textContent).not.toContain("Default");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("groups disabled controls under one reason", () => {
    const markup = renderToStaticMarkup(
      <SettingsUnavailableGroup message="Only available in the desktop app.">
        <SettingsRow title="Window capture" description="Capture a window." />
      </SettingsUnavailableGroup>,
    );

    expect(markup).toContain("Only available in the desktop app.");
    expect(markup).toContain("border-border/60");
    expect(markup).toContain("[&amp;_h3]:opacity-64");
  });
});

describe("settings search targets", () => {
  it("scrolls directly to a section header and restarts the destination pulse", () => {
    const sectionScrollIntoView = vi.fn();
    const headerScrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScrollIntoView },
      scrollIntoView: sectionScrollIntoView,
      focus,
      classList: { remove, add },
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(headerScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(sectionScrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(addEventListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("does not animate the destination when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList: { remove, add },
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).not.toHaveBeenCalled();
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => null),
    });

    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
