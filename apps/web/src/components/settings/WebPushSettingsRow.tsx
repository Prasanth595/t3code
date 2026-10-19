import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import {
  readPushRegistrationFailure,
  subscribePushRegistrationFailure,
} from "../../forkWebPushRegistration";
import { useEnvironmentIds } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { webPushTest } from "../../state/webPush";
import { environmentEndpoint, webPushSupported, webPushWanted } from "../../webPush";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectWebPushEnabled = (settings: ClientSettings) => settings.webPushEnabled;

/** Fork setting: Web Push from each connected server (`src/webPush.ts`). */
export function WebPushSettingsRow() {
  const enabled = useClientSettings(selectWebPushEnabled);
  const wanted = useClientSettings(webPushWanted);
  const environmentIds = useEnvironmentIds();
  const test = useAtomCommand(webPushTest, { reportFailure: false });
  const [testing, setTesting] = useState(false);
  const registrationFailure = useSyncExternalStore(
    subscribePushRegistrationFailure,
    readPushRegistrationFailure,
  );
  if (!webPushSupported()) return null;

  const sendTest = async () => {
    setTesting(true);
    let delivered = 0;
    const problems: string[] = [];
    for (const environmentId of environmentIds) {
      const endpoint = await environmentEndpoint(environmentId);
      if (endpoint === null) continue;
      const result = await test({ environmentId, input: { endpoint } });
      if (result._tag === "Success" && result.value.result === "delivered") {
        delivered += 1;
        continue;
      }
      const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
      problems.push(
        result._tag === "Success"
          ? `The server answered ${result.value.result}. Reload the page.`
          : error instanceof Error
            ? error.message
            : "The request failed.",
      );
    }
    setTesting(false);
    toastManager.add(
      problems.length === 0 && delivered > 0
        ? { type: "success", title: `Sent a test from ${delivered} server(s)` }
        : {
            type: "error",
            title: "Push test failed",
            description:
              problems.join(" ") || "No server has a subscription of this device. Reload the page.",
          },
    );
  };

  return (
    <SettingsRow
      {...searchableSetting("web-push")}
      description={
        <>
          Thread notifications on this device while T3 Code is closed, from each connected server.
          Needs the installed app and system notifications.
          {wanted && registrationFailure ? (
            <span role="status" className="block text-destructive">
              {registrationFailure === "retrying"
                ? "Registration failed for a server. Retrying…"
                : "Registration failed for a server. Reconnect or reload to try again."}
            </span>
          ) : null}
        </>
      }
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.webPushEnabled ? (
          <SettingResetButton
            label="Web Push"
            onClick={() =>
              void updateClientSettings({ webPushEnabled: DEFAULT_CLIENT_SETTINGS.webPushEnabled })
            }
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          {wanted ? (
            <Button size="sm" variant="outline" disabled={testing} onClick={() => void sendTest()}>
              Send a test
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => void updateClientSettings({ webPushEnabled: checked })}
            aria-label="Web Push"
          />
        </div>
      }
    />
  );
}
