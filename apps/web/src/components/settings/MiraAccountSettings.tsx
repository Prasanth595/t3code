import { useAuth } from "@clerk/react";
import type { SaasAccountResponse } from "@t3tools/contracts/saas";
import { CloudIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  MIRA_UPGRADE_PLAN_ID,
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
    }, reportFailure("Planul Mira nu a putut fi încărcat"));
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
          title="Neautentificat"
          description="Chat-ul merge fără cont pentru câteva mesaje pe zi. Autentifică-te pentru chat nelimitat și ca să-ți accesezi calculatoarele de la distanță."
          control={
            <Button size="xs" disabled={!isLoaded} onClick={openAuthPrompt}>
              Autentifică-te
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
        title={account ? `Planul ${account.plan.name}` : "Se încarcă planul…"}
        description={account?.email ?? undefined}
        control={
          isPaid ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => run("Facturarea nu a putut fi deschisă", openMiraBillingPortal)}
            >
              Gestionează facturarea
            </Button>
          ) : (
            <Button
              size="xs"
              disabled={busy || account === null}
              onClick={() =>
                run("Upgrade-ul nu a putut porni", () => openMiraCheckout(MIRA_UPGRADE_PLAN_ID))
              }
            >
              Upgrade
            </Button>
          )
        }
      />
      {account ? (
        <SettingsRow
          title="Chat"
          description={
            account.chat.dailyLimit === null
              ? "Nelimitat."
              : `${account.chat.messagesToday} din ${account.chat.dailyLimit} mesaje azi. Se resetează la miezul nopții UTC.`
          }
        />
      ) : null}
      {account ? (
        <SettingsRow
          title="Mod agent"
          description={
            account.plan.agenticEnabled
              ? `${formatMiraTokens(used)} din ${formatMiraTokens(account.plan.monthlyTokenLimit)} tokeni luna aceasta. Se resetează pe 1 ale lunii, UTC.`
              : "Disponibil cu Pro: Mira lucrează pe calculatorul tău, editează fișiere și rulează comenzi."
          }
        />
      ) : null}
    </SettingsSection>
  );
}
