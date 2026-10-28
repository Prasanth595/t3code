import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { collectLimitAccounts, limitsNotice } from "@t3tools/shared/usageLimits";
import { formatTokens, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { latestRunCompletionAtom, refreshUsageTotals, useUsage } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  USAGE_PANEL_WINDOW_DAYS,
  useUsagePanelStore,
  type UsagePanelWindowDays,
} from "../../usagePanelStore";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { LimitWindows } from "../usage/UsageLimits";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "../usage/usageProviders";
import { orderUsageDrivers, usageRefreshDelay } from "./threadUsagePanel.logic";

const WINDOW_LABELS: Record<UsagePanelWindowDays, string> = { 1: "Today", 7: "7d", 30: "30d" };

const kindByDriver = new Map(
  PROVIDER_ORDER.map((kind) => [String(PROVIDER_PRESENTATION[kind].driverKind), kind] as const),
);

// useUsage derives its totals again whenever the selection changes identity.
const selections = new Map<EnvironmentId, ReadonlySet<EnvironmentId>>();
const environmentSelection = (environmentId: EnvironmentId): ReadonlySet<EnvironmentId> => {
  const known = selections.get(environmentId);
  if (known !== undefined) return known;
  const created = new Set([environmentId]);
  selections.set(environmentId, created);
  return created;
};

const driverRank = (driver: string) => {
  const kind = kindByDriver.get(driver);
  return kind === undefined ? PROVIDER_ORDER.length : PROVIDER_ORDER.indexOf(kind);
};

function driverLabel(driver: ServerProvider["driver"]): string {
  const kind = kindByDriver.get(String(driver));
  return kind === undefined
    ? (providerClients.get(driver)?.label ?? String(driver))
    : PROVIDER_PRESENTATION[kind].label;
}

/**
 * Finished runs spend quota, so each one asks for a refresh. They coalesce into at most one per
 * interval, and the card reads the Usage page's cached snapshots in between.
 */
function useRefreshOnRunCompletion(
  refresh: () => void,
  environmentId: EnvironmentId,
  lastRefreshAt: RefObject<number | null>,
) {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useEffectEvent(() => {
    pending.current = null;
    refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the environment's run completions in the atom registry and schedules a throttled refresh
  useEffect(() => {
    const unsubscribe = appAtomRegistry.subscribe(latestRunCompletionAtom(environmentId), () => {
      if (pending.current !== null) return;
      const delay = usageRefreshDelay(lastRefreshAt.current, Date.now());
      if (delay === 0) run();
      else pending.current = setTimeout(run, delay);
    });
    return () => {
      unsubscribe();
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [environmentId, lastRefreshAt]);
}

export function ThreadUsagePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly providerDriver: ServerProvider["driver"] | null;
}) {
  const { environmentId, providerDriver } = props;
  const windowDays = useUsagePanelStore((state) => state.windowDays);
  const setWindowDays = useUsagePanelStore((state) => state.setWindowDays);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const window = makeWindow(windowDays, undefined, "day");
  const selectedEnvironments = environmentSelection(environmentId);
  const { merged, shown, environments } = useUsage(window, selectedEnvironments);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const lastRefreshAt = useRef<number | null>(null);
  const refreshNow = () => {
    lastRefreshAt.current = Date.now();
    setRefreshing(true);
    refreshUsageTotals(environmentId, window);
    void refreshUsageLimits(environmentId, () => refreshProviders({ environmentId, input: {} }))
      .catch(() => undefined)
      .finally(() => {
        setNow(Date.now());
        setRefreshing(false);
      });
  };
  useRefreshOnRunCompletion(refreshNow, environmentId, lastRefreshAt);

  const presentation = presentations.get(environmentId);
  const accounts =
    presentation === undefined
      ? []
      : collectLimitAccounts(new Map([[environmentId, presentation]]));
  const totalsByDriver = new Map(
    (shown?.merged ?? merged).providers.map((totals) => [
      String(PROVIDER_PRESENTATION[totals.provider].driverKind),
      totals,
    ]),
  );
  const enabledDrivers = (presentation?.serverConfig?.providers ?? [])
    .filter((provider) => provider.enabled)
    .map((provider) => provider.driver);
  const visibleDrivers = orderUsageDrivers(
    [...(providerDriver === null ? [] : [providerDriver]), ...enabledDrivers],
    providerDriver,
    driverRank,
  );
  const loading = shown === null && environments.some((environment) => environment.isPending);

  return (
    <section aria-label="Usage" className="flex flex-col gap-1 px-2 pt-2 pb-2.5">
      <div className="flex min-h-8 items-center justify-between gap-2 px-2.5">
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(windowDays)]}
          onValueChange={(next) => {
            const days = Number(next[0]);
            if (USAGE_PANEL_WINDOW_DAYS.some((option) => option === days)) {
              setWindowDays(days as UsagePanelWindowDays);
            }
          }}
        >
          {USAGE_PANEL_WINDOW_DAYS.map((days) => (
            <Toggle key={days} value={String(days)}>
              {WINDOW_LABELS[days]}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          aria-label="Refresh usage"
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={refreshNow}
          size="icon-xs"
          variant="ghost-muted"
        >
          <RefreshIcon size="sm" refreshing={refreshing} />
        </Button>
      </div>
      {loading ? <p className="px-2.5 py-1 text-xs text-muted-foreground">Loading usage…</p> : null}
      {!loading && visibleDrivers.length === 0 ? (
        <p className="px-2.5 py-1 text-xs text-muted-foreground">No enabled providers.</p>
      ) : null}
      {visibleDrivers.map((driver) => {
        const kind = kindByDriver.get(String(driver));
        const totals = totalsByDriver.get(String(driver));
        const driverAccounts = accounts.filter((account) => account.driver === driver);
        return (
          <div key={driver} className="flex min-w-0 flex-col gap-1.5 px-2.5 py-1">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: kind ? PROVIDER_PRESENTATION[kind].color : "currentColor" }}
              />
              <span className="min-w-0 truncate text-xs font-medium">{driverLabel(driver)}</span>
              <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {totals === undefined
                  ? "No usage"
                  : `${formatTokens(totals.totalTokens)} · ${formatUsd(totals.costUsd)}`}
              </span>
            </div>
            {driverAccounts.map((account) => {
              const notice = limitsNotice(account.limits);
              return (
                <div key={account.key} className="flex min-w-0 flex-col gap-1">
                  {driverAccounts.length > 1 ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {account.displayName ?? account.email ?? account.plan ?? account.key}
                    </span>
                  ) : null}
                  {notice ? (
                    <span className="text-xs text-muted-foreground">{notice}</span>
                  ) : (
                    <LimitWindows
                      compact
                      driver={account.driver}
                      windows={account.limits.windows}
                      now={now}
                    />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
