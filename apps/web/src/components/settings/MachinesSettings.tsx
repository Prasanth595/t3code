import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type ClientAccessMode,
  type MachineLevel,
  type MachineMapConnectionStatus,
  MachineMapRequestError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { joinMachineMap, leaveMachineMap, useMachineMapState } from "../../state/machineMap";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Fork: Settings > Machines (apps/machine-map/SPEC.md MM-203, MM-1004). The state of the machine
 * map on the selected environment: join with a code, leave, and the machines it can use.
 */

const STATUS_BADGES: Record<
  MachineMapConnectionStatus,
  { readonly label: string; readonly variant: "outline" | "warning" | "success" }
> = {
  off: { label: "Off", variant: "outline" },
  "not-joined": { label: "Not joined", variant: "outline" },
  connecting: { label: "Connecting", variant: "warning" },
  online: { label: "Online", variant: "success" },
};

const LEVEL_BADGES: Record<
  MachineLevel,
  { readonly label: string; readonly variant: "outline" | "info" | "secondary" | "warning" }
> = {
  none: { label: "None", variant: "outline" },
  read: { label: "Read", variant: "secondary" },
  standard: { label: "Standard", variant: "info" },
  admin: { label: "Admin", variant: "warning" },
};

const isMachineMapRequestError = Schema.is(MachineMapRequestError);

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  if (isMachineMapRequestError(error)) return error.detail;
  return error instanceof Error ? error.message : "The request failed.";
}

export function MachinesSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { state } = useMachineMapState(environmentId);
  if (environmentId === null) return null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Machine map">
        <MachineMapSettingsRows />
        {state?.joined ? <ClientAccessSettingsRow /> : null}
      </SettingsSection>

      {state?.joined ? (
        <SettingsSection {...searchableSetting("machine-map-reachable")}>
          {state.reachable.length === 0 ? (
            <SettingsRow
              title="No machines"
              description="Give this machine an arrow to another machine in the portal."
            />
          ) : (
            state.reachable.map((peer) => {
              const level = LEVEL_BADGES[peer.level];
              return (
                <SettingsRow
                  key={peer.machine.id}
                  title={peer.machine.name}
                  description={peer.agentTools ? `${peer.origin}, with agent tools` : peer.origin}
                  control={
                    <div className="flex items-center gap-2">
                      <Badge variant={level.variant}>{level.label}</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        render={<a href={peer.origin} target="_blank" rel="noreferrer" />}
                      >
                        Open
                      </Button>
                    </div>
                  }
                />
              );
            })
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

const CLIENT_ACCESS_LABELS: Record<ClientAccessMode, string> = {
  off: "Off",
  observe: "Observe",
  enforce: "Enforce",
};

/**
 * MM-919: the way back in when `enforce` locks every browser out. The portal sets `clientAccess`
 * on the approval path; on a machine, only its own desktop app may change it, and the portal then
 * sends a push message.
 */
function ClientAccessSettingsRow() {
  const mode = useScopedSettings((settings) => settings.clientAccess);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("machine-map-client-access")}
      serverScoped
      settingKeys={["clientAccess"]}
      description="Which browsers get in through Cloudflare Access. Set it in the portal. Only the desktop app of this machine changes it here, as the way back in."
      control={
        <Select
          value={mode}
          disabled={!isElectron}
          onValueChange={(value) => {
            if (value !== "off" && value !== "observe" && value !== "enforce") return;
            updateSettings({ clientAccess: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Client access">
            <SelectValue>{CLIENT_ACCESS_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(CLIENT_ACCESS_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** The machine map connection of the selected environment: status, join, and leave. */
export function MachineMapSettingsRows() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { state, error } = useMachineMapState(environmentId);
  const canJoin = useAtomValue(joinMachineMap.permissionAtom(environmentId));
  const canLeave = useAtomValue(leaveMachineMap.permissionAtom(environmentId));
  const join = useAtomCommand(joinMachineMap, { reportFailure: false });
  const leave = useAtomCommand(leaveMachineMap, { reportFailure: false });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  if (environmentId === null) return null;
  if (state === null) {
    return (
      <SettingsRow
        {...searchableSetting("machine-map")}
        description={
          error === null
            ? "Loading the machine map..."
            : `This environment does not show the machine map. ${error}`
        }
      />
    );
  }

  const status = STATUS_BADGES[state.connection.status];
  const selfName = state.desired?.self.name ?? null;
  const trimmedCode = code.trim();

  const submitJoin = async () => {
    if (trimmedCode.length === 0 || busy) return;
    setBusy(true);
    setRequestError(null);
    const result = await join({ environmentId, input: { code: trimmedCode } });
    setBusy(false);
    if (result._tag === "Failure") setRequestError(failureMessage(result));
    else setCode("");
  };

  const submitLeave = async () => {
    if (busy) return;
    // Fail closed: no mounted confirm host means no leave.
    const confirmed = await requestConfirmDialog(
      "Leave the machine map?\nThis machine forgets its machine token, and other machines lose their access to it.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    setRequestError(null);
    const result = await leave({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure") setRequestError(failureMessage(result));
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("machine-map")}
        description={
          selfName === null
            ? "One portal controls what each machine can do on the other machines."
            : `This machine is ${selfName} on the map.`
        }
        status={
          state.connection.lastError === null
            ? `Since ${formatRelativeTimeLabel(state.connection.since)}`
            : `Last error: ${state.connection.lastError}`
        }
        control={
          <div className="flex items-center gap-2">
            <Badge variant={status.variant}>{status.label}</Badge>
            <Button
              size="sm"
              variant="outline"
              render={<a href={state.portalUrl} target="_blank" rel="noreferrer" />}
            >
              Open portal
            </Button>
          </div>
        }
      />
      {state.joined ? (
        <SettingsRow
          title="Leave the map"
          description="Forget the machine token and turn the machine map off."
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!canLeave || busy}
              onClick={() => void submitLeave()}
            >
              Leave
            </Button>
          }
        />
      ) : (
        <SettingsRow
          title="Join the map"
          description="In the portal, Add machine shows a one-time join code."
          control={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitJoin();
              }}
            >
              <Input
                size="sm"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Join code"
                aria-label="Join code"
                autoComplete="off"
                disabled={!canJoin || busy}
              />
              <Button size="sm" type="submit" disabled={!canJoin || busy || trimmedCode === ""}>
                Join
              </Button>
            </form>
          }
        />
      )}
      {requestError === null ? null : (
        <SettingsRow title="Request failed" description={requestError} />
      )}
    </>
  );
}
