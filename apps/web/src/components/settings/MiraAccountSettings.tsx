import { useAuth } from "@clerk/react";
import type { SaasAccountResponse } from "@t3tools/contracts/saas";
import { CloudIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  fetchMiraAccount,
  formatMiraTokens,
  openMiraBillingPortal,
  openMiraCheckout,
} from "../../cloud/miraAccount";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// The paid plan the Upgrade button buys; admins set its Stripe price in the admin page.
const UPGRADE_PLAN_ID = "pro";

const reportFailure = (title: string) => (cause: unknown) => {
  toastManager.add({
    type: "error",
    title,
    description: cause instanceof Error ? cause.message : String(cause),
  });
};

export function MiraAccountSettings() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [account, setAccount] = useState<SaasAccountResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetchMiraAccount().then((next) => {
      if (!cancelled) setAccount(next);
    }, reportFailure("Could not load your Mira plan"));
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  if (!hasCloudPublicConfig()) return null;

  const run = (title: string, action: () => Promise<void>) => {
    setBusy(true);
    action()
      .catch(reportFailure(title))
      .finally(() => setBusy(false));
  };

  if (!isSignedIn) {
    return (
      <SettingsSection title="Mira account" icon={<CloudIcon aria-hidden className="size-4" />}>
        <SettingsRow
          title="Not signed in"
          description="Sign in to use the Mira model and reach your computers remotely."
          control={
            <Button size="xs" disabled={!isLoaded} onClick={openAuthPrompt}>
              Sign in
            </Button>
          }
        />
      </SettingsSection>
    );
  }

  const used = account ? account.usage.inputTokens + account.usage.outputTokens : 0;
  const isPaid = account !== null && account.plan.priceCents > 0;
  return (
    <SettingsSection title="Mira account" icon={<CloudIcon aria-hidden className="size-4" />}>
      <SettingsRow
        title={account ? `${account.plan.name} plan` : "Loading plan…"}
        description={account?.email ?? undefined}
        control={
          isPaid ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => run("Could not open billing", openMiraBillingPortal)}
            >
              Manage billing
            </Button>
          ) : (
            <Button
              size="xs"
              disabled={busy || account === null}
              onClick={() =>
                run("Could not start the upgrade", () => openMiraCheckout(UPGRADE_PLAN_ID))
              }
            >
              Upgrade
            </Button>
          )
        }
      />
      {account ? (
        <SettingsRow
          title="Usage this month"
          description={`${formatMiraTokens(used)} of ${formatMiraTokens(account.plan.monthlyTokenLimit)} tokens. Resets on the 1st, in UTC.`}
        />
      ) : null}
    </SettingsSection>
  );
}
