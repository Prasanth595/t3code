import type { DesktopBridge } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { desktopChangeRequestLinksAvailable, searchableSetting } from "./settingsSearch";

type DesktopBrowsers = Awaited<
  ReturnType<NonNullable<NonNullable<DesktopBridge["webLinks"]>["listBrowsers"]>>
>;

export function DesktopChangeRequestLinksSetting() {
  return desktopChangeRequestLinksAvailable() ? <DesktopChangeRequestLinksControl /> : null;
}

function DesktopChangeRequestLinksControl() {
  const enabled = useClientSettings((settings) => settings.desktopChangeRequestLinksEnabled);
  const browserId = useClientSettings((settings) => settings.desktopLinkFallbackBrowserId);
  const hydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  const webLinks = window.desktopBridge?.webLinks;
  const [browsers, setBrowsers] = useState<DesktopBrowsers | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [openingSettings, setOpeningSettings] = useState(false);
  const selectedBrowser = browsers?.find((browser) => browser.id === browserId);

  useEffect(() => {
    let cancelled = false;
    void webLinks?.listBrowsers?.().then(
      (installed) => {
        if (!cancelled) setBrowsers(installed);
      },
      () => {
        if (!cancelled) {
          setBrowserError("Could not load installed browsers. Reopen settings to try again.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [webLinks]);

  async function openSettings() {
    setOpeningSettings(true);
    try {
      if (!(await webLinks?.openSettings?.())) {
        throw new Error("System Settings did not open.");
      }
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not open System Settings",
        description: "Open Desktop & Dock → Default web browser manually.",
      });
    } finally {
      setOpeningSettings(false);
    }
  }

  return (
    <SettingsRow
      {...searchableSetting("desktop-change-request-links")}
      description="Open PR and MR links from other apps in matching projects, including GitHub, GitLab, and Forgejo."
      status={
        browserError ??
        (browsers?.length === 0
          ? "Install another web browser before enabling this setting."
          : browsers && browserId && !selectedBrowser
            ? "Your selected browser is unavailable. Choose another browser below."
            : !selectedBrowser
              ? "Choose a browser for other links before enabling this setting."
              : undefined)
      }
      control={
        <Switch
          checked={enabled}
          disabled={!hydrated || (!enabled && !selectedBrowser)}
          aria-label="Open PR and MR links in T3 Code"
          onCheckedChange={(checked) => {
            if (!checked || selectedBrowser) {
              void updateSettings({ desktopChangeRequestLinksEnabled: checked });
            }
          }}
        />
      }
    >
      <div className="space-y-3 pt-3 pb-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">Browser for other links</p>
          <div className="w-full sm:w-40">
            <Select
              value={selectedBrowser?.id ?? null}
              disabled={!hydrated || !browsers?.length}
              onValueChange={(value) => {
                if (browsers?.some((browser) => browser.id === value)) {
                  void updateSettings({ desktopLinkFallbackBrowserId: value });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Browser for other links">
                <SelectValue>
                  {selectedBrowser?.name ??
                    (browserError
                      ? "Unavailable"
                      : browsers
                        ? "Choose browser"
                        : "Loading browsers…")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {browsers?.map((browser) => (
                  <SelectItem key={browser.id} value={browser.id}>
                    {browser.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
            {enabled
              ? "Choose T3 Code under System Settings → Desktop & Dock → Default web browser. Other links open in your chosen browser."
              : "After enabling, choose T3 Code as your default web browser in System Settings → Desktop & Dock. To stop receiving links in T3 Code, choose your browser there again."}
          </p>
          <div className="shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={openingSettings}
              onClick={() => void openSettings()}
            >
              Open System Settings
            </Button>
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}
