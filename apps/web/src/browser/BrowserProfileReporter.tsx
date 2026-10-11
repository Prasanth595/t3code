import {
  AuthPreviewOperateScope,
  type BrowserProfile,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

/** A failed report retries this many times, waiting longer each time. */
const MAX_REPORT_RETRIES = 3;
const REPORT_RETRY_DELAY_MS = 5_000;

const selectProfiles = (settings: { readonly browserProfiles: ReadonlyArray<BrowserProfile> }) =>
  settings.browserProfiles;
const selectDefaultProfileId = (settings: { readonly browserDefaultProfileId: string }) =>
  settings.browserDefaultProfileId;

/**
 * Tells each environment that hosts browser tabs which profiles this client
 * has, so agents can open tabs under them. Profiles live in client settings;
 * the server keeps only the latest report in memory. A reconnect brings a new
 * server config, which sends the report again. Disconnected environments and
 * unchanged reports are skipped: session and config churn re-runs the effect.
 */
export function BrowserProfileReporter() {
  const hydrated = useClientSettingsHydrated();
  const profiles = useClientSettings(selectProfiles);
  const defaultProfileId = useClientSettings(selectDefaultProfileId);
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const operable = useEnvironmentsWithScope(environments, AuthPreviewOperateScope);
  const connected = useConnectedEnvironmentIds();
  const report = useAtomCommand(previewEnvironment.reportProfiles, { reportFailure: false });
  const reported = useRef(
    new Map<
      EnvironmentId,
      {
        readonly config: ServerConfig;
        readonly profiles: ReadonlyArray<BrowserProfile>;
        readonly defaultProfileId: string;
        failures: number;
        pending: boolean;
        sent: boolean;
      }
    >(),
  );
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The latest report pass, for a retry to run with current settings. */
  const sweep = useRef<() => void>(() => {});

  useEffect(
    () => () => {
      sweep.current = () => {};
      reported.current.clear();
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!hydrated) return;
    const reportChanged = () => {
      for (const environmentId of reported.current.keys()) {
        if (!connected.includes(environmentId)) reported.current.delete(environmentId);
      }
      for (const environmentId of connected) {
        const config = serverConfigs.get(environmentId);
        if (!config?.environment.capabilities.serverBrowser || !operable.has(environmentId))
          continue;
        const last = reported.current.get(environmentId);
        const unchanged =
          last?.config === config &&
          last.profiles === profiles &&
          last.defaultProfileId === defaultProfileId;
        if (unchanged && (last.pending || last.sent || last.failures > MAX_REPORT_RETRIES)) {
          continue;
        }
        // A new report tuple gets its own retry budget.
        const entry = unchanged
          ? last
          : { config, profiles, defaultProfileId, failures: 0, pending: false, sent: false };
        entry.pending = true;
        reported.current.set(environmentId, entry);
        void report({ environmentId, input: { profiles, defaultProfileId } }).then((result) => {
          // Disconnect, replacement, and unmount invalidate this completion.
          if (reported.current.get(environmentId) !== entry) return;
          entry.pending = false;
          if (result._tag === "Success") {
            entry.sent = true;
            entry.failures = 0;
            return;
          }
          if (isAtomCommandInterrupted(result)) return;
          const attempt = ++entry.failures;
          if (attempt > MAX_REPORT_RETRIES || retryTimer.current !== null) return;
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            sweep.current();
          }, REPORT_RETRY_DELAY_MS * attempt);
        });
      }
    };
    sweep.current = reportChanged;
    reportChanged();
  }, [connected, defaultProfileId, hydrated, operable, profiles, report, serverConfigs]);

  return null;
}
