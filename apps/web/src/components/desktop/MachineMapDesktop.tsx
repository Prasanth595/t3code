import { requestHeaderOrigin } from "@t3tools/client-runtime/connection";
import type {
  ClientSettings,
  EnvironmentId,
  MachineCommand,
  MachineMapClientState,
  MachineMapDesktopReport,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  connectPairing as connectPairingAtom,
  readRequestHeaders as readRequestHeadersAtom,
  saveRequestHeaders as saveRequestHeadersAtom,
} from "../../connection/onboarding";
import { requestSiblingPairingCredential } from "../../connection/siblingEnvironments";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import {
  clientSettingsPatchFromDesired,
  clientSettingsReportKey,
  planMachineSync,
  sameRequestHeaders,
  type SavedEnvironment,
  tokenRequestHeaders,
} from "../../machineMap/desktopSync.logic";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { reportMachineMapDesktop, useMachineMapState } from "../../state/machineMap";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import { armIdleInstall } from "./DesktopUpdateIdleInstall";

/**
 * Fork: the desktop app's part of the machine map (apps/machine-map/SPEC.md). It reads the state
 * of its own server and only acts while that server reports `tokenHeaders`, which it sends only
 * to the local desktop app of a joined machine.
 *
 * - MM-306, MM-1401: one saved environment for each reachable machine, with the token headers.
 * - MM-403: applies the desired client settings and reports the current ones.
 * - MM-1402: runs `reloadWindows` and `installUpdate`, and reports the waiting update.
 */
export function MachineMapDesktop() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const connected = primary?.connection.phase === "connected";
  const { state } = useMachineMapState(environmentId);
  if (environmentId === null || state === null) return null;
  return (
    <>
      <MachineCatalogSync state={state} primaryEnvironmentId={environmentId} />
      {state.tokenHeaders === null ? null : (
        <MachineDesktopReports state={state} environmentId={environmentId} connected={connected} />
      )}
    </>
  );
}

// --- MM-306, MM-1401: saved environments ----------------------------------------------------

const MANAGED_ORIGINS_KEY = "t3code:machine-map:managed-origins";
const decodeManagedOrigins = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

/** The origins this app added for the map. Only these get removed again. */
function readManagedOrigins(): Set<string> {
  const raw = globalThis.localStorage.getItem(MANAGED_ORIGINS_KEY);
  if (raw === null) return new Set();
  const decoded = decodeManagedOrigins(raw);
  if (decoded._tag === "None") throw new Error(`${MANAGED_ORIGINS_KEY} holds an invalid value.`);
  return new Set(decoded.value);
}

function writeManagedOrigins(origins: ReadonlySet<string>): void {
  globalThis.localStorage.setItem(MANAGED_ORIGINS_KEY, JSON.stringify([...origins]));
}

function MachineCatalogSync({
  state,
  primaryEnvironmentId,
}: {
  readonly state: MachineMapClientState;
  readonly primaryEnvironmentId: EnvironmentId;
}) {
  const { isReady, environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const readRequestHeaders = useAtomCommand(readRequestHeadersAtom, { reportFailure: false });
  const saveRequestHeaders = useAtomCommand(saveRequestHeadersAtom, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const repairAttempted = useRef(new Set<string>());
  const running = useRef(false);
  const runAgain = useRef(false);

  const saved = useMemo(
    () =>
      environments
        .filter((environment) => environment.environmentId !== primaryEnvironmentId)
        .map((environment): SavedEnvironment => ({
          environmentId: environment.environmentId,
          origin:
            environment.displayUrl === null ? null : requestHeaderOrigin(environment.displayUrl),
          phase: environment.connection.phase,
        })),
    [environments, primaryEnvironmentId],
  );
  const savedKey = stableStringify(saved);

  const syncOnce = async () => {
    for (const environment of saved) {
      // A working connection ends the failure, so the next failure may pair again.
      if (environment.origin !== null && environment.phase === "connected") {
        repairAttempted.current.delete(environment.origin);
      }
    }
    const managed = readManagedOrigins();
    const plan = planMachineSync({
      state,
      managedOrigins: managed,
      environments: saved,
      repairAttempted: repairAttempted.current,
    });

    for (const { origin, environmentId } of plan.remove) {
      if (environmentId !== null) {
        const removed = await removeEnvironment(environmentId);
        if (removed._tag === "Failure") continue;
      }
      const cleared = await saveRequestHeaders({ origin, headers: [] });
      if (cleared._tag === "Failure") continue;
      managed.delete(origin);
      repairAttempted.current.delete(origin);
      writeManagedOrigins(managed);
    }

    if (state.tokenHeaders === null) return;
    const headers = tokenRequestHeaders(state.tokenHeaders);
    for (const origin of plan.keep) {
      // Mark it first: a failed pairing still leaves headers that a later removal must clear.
      managed.add(origin);
      writeManagedOrigins(managed);
      const current = await readRequestHeaders(origin);
      if (current._tag === "Success" && sameRequestHeaders(current.value, headers)) continue;
      await saveRequestHeaders({ origin, headers });
    }

    for (const origin of plan.pair) {
      if (saved.some((environment) => environment.origin === origin)) {
        repairAttempted.current.add(origin);
      }
      try {
        // Electron adds the token headers to this request, and only for this origin.
        const pairingCode = await requestSiblingPairingCredential(origin, "omit");
        const result = await connectPairing({ host: origin, pairingCode });
        if (result._tag === "Failure") throw new Error(`Pairing with ${origin} failed.`);
      } catch (error) {
        console.warn("Machine map: could not add a machine.", origin, error);
      }
    }
  };

  // One run at a time. A trigger during a run starts one more run after it.
  const sync = useEffectEvent(async () => {
    if (!isReady) return;
    if (running.current) {
      runAgain.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        runAgain.current = false;
        await syncOnce();
      } while (runAgain.current);
    } catch (error) {
      console.error("Machine map: could not sync the saved environments.", error);
    } finally {
      running.current = false;
    }
  });

  useEffect(() => {
    void sync();
  }, [state, savedKey, isReady]);

  useEffect(() => {
    const onFocus = () => void sync();
    globalThis.addEventListener("focus", onFocus);
    return () => globalThis.removeEventListener("focus", onFocus);
  }, []);

  return null;
}

// --- MM-403, MM-1402: settings, commands and reports ----------------------------------------

type CommandOutcome = {
  readonly ok: boolean;
  readonly result: unknown;
  readonly error: string | null;
  /** Runs after the result reached the server: it can end this window or its server. */
  readonly after?: () => void;
};

const UPDATE_STATE_WAIT_MS = 60_000;

function MachineDesktopReports({
  state,
  environmentId,
  connected,
}: {
  readonly state: MachineMapClientState;
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const report = useAtomCommand(reportMachineMapDesktop, { reportFailure: false });
  const send = (input: MachineMapDesktopReport) => report({ environmentId, input });
  const clientSettings = useClientSettings();
  const hydrated = useClientSettingsHydrated();
  const updateState = useDesktopUpdateState();
  const updateWaiting =
    updateState !== null && resolveDesktopUpdateButtonAction(updateState) === "install"
      ? getDesktopUpdateDownloadedVersion(updateState)
      : null;
  const reportedSettings = useRef<string | null>(null);
  const reportedUpdate = useRef<string | null | undefined>(undefined);
  const handledCommands = useRef(new Set<string>());
  // A desktop app without an update state after this wait has no update to install.
  const [updateStateWaitOver, setUpdateStateWaitOver] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setUpdateStateWaitOver(true), UPDATE_STATE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // The server keeps the reports in memory, so a new connection gets them again.
  useEffect(() => {
    if (!connected) return;
    reportedSettings.current = null;
    reportedUpdate.current = undefined;
  }, [connected]);

  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- the client settings scope, not an RPC client.
  const desiredClient = state.desired?.settings.client ?? null;
  const desiredKey = stableStringify(desiredClient);
  const applyDesiredClientSettings = useEffectEvent(async () => {
    if (desiredClient === null) return;
    // Before hydration the snapshot holds the defaults, not the saved settings.
    await ensureClientSettingsHydrated();
    const { patch, skipped } = clientSettingsPatchFromDesired(desiredClient, getClientSettings());
    if (skipped.length > 0) {
      console.warn("Machine map: skipped client settings that do not apply here.", skipped);
    }
    if (Object.keys(patch).length > 0) await persistClientSettingsPatch(patch);
  });
  useEffect(() => {
    void applyDesiredClientSettings();
    // The key stands for the desired values, which arrive as a new object on each push.
  }, [desiredKey]);

  const reportClientSettings = useEffectEvent((settings: ClientSettings) => {
    const key = clientSettingsReportKey(settings);
    if (key === reportedSettings.current) return;
    reportedSettings.current = key;
    // The server leaves out values equal to the desired ones: the map's own writes (MM-404).
    void send({ clientSettings: settings }).then((result) => {
      if (result._tag === "Failure" && reportedSettings.current === key) {
        reportedSettings.current = null;
      }
    });
  });
  useEffect(() => {
    if (hydrated && connected) reportClientSettings(clientSettings);
  }, [clientSettings, hydrated, connected]);

  const reportUpdateWaiting = useEffectEvent((version: string | null) => {
    if (reportedUpdate.current === version) return;
    reportedUpdate.current = version;
    void send({ updateWaiting: version }).then((result) => {
      if (result._tag === "Failure") reportedUpdate.current = undefined;
    });
  });
  useEffect(() => {
    if (connected) reportUpdateWaiting(updateWaiting);
  }, [updateWaiting, connected]);

  const runCommand = (command: MachineCommand): CommandOutcome => {
    switch (command.input._tag) {
      case "reloadWindows":
        return {
          ok: true,
          result: { reloaded: true },
          error: null,
          after: () => globalThis.location.reload(),
        };
      case "installUpdate": {
        const bridge = window.desktopBridge;
        if (
          bridge === undefined ||
          updateState === null ||
          resolveDesktopUpdateButtonAction(updateState) !== "install"
        ) {
          return { ok: false, result: null, error: "No update waits to install." };
        }
        const version = getDesktopUpdateDownloadedVersion(updateState);
        // The install restarts the server or the app, so it reports first. A failed install
        // then shows only in the app, as a toast.
        if (command.input.whenIdle) {
          return {
            ok: true,
            result: { version, whenIdle: true },
            error: null,
            after: armIdleInstall,
          };
        }
        return {
          ok: true,
          result: { version, whenIdle: false },
          error: null,
          after: () => void installLocalUpdate(bridge),
        };
      }
      default:
        return {
          ok: false,
          result: null,
          error: `The desktop app does not run ${command.input._tag}.`,
        };
    }
  };

  const runCommands = useEffectEvent((commands: ReadonlyArray<MachineCommand>) => {
    for (const command of commands) {
      if (handledCommands.current.has(command.id)) continue;
      const expired = Date.parse(command.expiresAt) <= Date.now();
      // MM-1402: after the start, the update state passes "disabled" and "checking" before it
      // can say "install". Until it does, or the wait is over, "no update" is unknown.
      if (
        !expired &&
        command.input._tag === "installUpdate" &&
        (updateState === null || resolveDesktopUpdateButtonAction(updateState) !== "install") &&
        !updateStateWaitOver
      ) {
        continue;
      }
      handledCommands.current.add(command.id);
      // MM-605: a command that waited past its expiry never runs.
      const outcome: CommandOutcome = expired
        ? { ok: false, result: null, error: "Expired before the desktop app ran it." }
        : runCommand(command);
      void send({
        commandResult: {
          commandId: command.id,
          ok: outcome.ok,
          result: outcome.result,
          error: outcome.error,
        },
      }).then((result) => {
        // Unreported, it stays queued on the server and runs again on the next push.
        if (result._tag === "Failure") handledCommands.current.delete(command.id);
        else outcome.after?.();
      });
    }
  });
  useEffect(() => {
    runCommands(state.desktopCommands);
  }, [state.desktopCommands, updateState, updateStateWaitOver]);

  return null;
}
