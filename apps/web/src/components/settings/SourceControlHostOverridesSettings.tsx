import { useAtomValue } from "@effect/atom-react";
import {
  SourceControlHostName,
  SourceControlHostOverride,
  type EnvironmentId,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const isHostName = Schema.is(SourceControlHostName);
const isHostOverride = Schema.is(SourceControlHostOverride);
const isProviderKind = Schema.is(SourceControlHostOverride.fields.kind);

export function SourceControlHostOverridesSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sourceControlHostOverrides,
  );
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save source control host mapping",
  });
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const save = async (
    host: string,
    value: SourceControlHostOverride | null,
    previous?: string | null,
  ) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          sourceControlHostOverrides: {
            ...(previous && previous !== host ? { [previous]: null } : {}),
            [host]: value,
          },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") setEditing(undefined);
  };

  return (
    <SettingsSection
      title="Custom hosts"
      id={searchableSetting("source-control-host-overrides").id}
    >
      <fieldset disabled={saving || !canEdit} className="grid gap-4 px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Choose the integration for a self-hosted server. Mappings override automatic detection;
          sign in with that integration on this environment's server as usual.
        </p>
        {Object.entries(saved).map(([host, value]) => (
          <div key={host} className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-xs">
              <p className="break-all font-medium">
                {host} · {sourceControlClients.get(value.kind).label}
              </p>
              {value.baseUrl ? (
                <p className="break-all text-muted-foreground">{value.baseUrl}</p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="outline"
                aria-label={`Edit mapping for ${host}`}
                onClick={() => setEditing(host)}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="outline"
                aria-label={`Remove mapping for ${host}`}
                onClick={() => void save(host, null)}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        {editing === undefined ? (
          <div>
            <Button size="xs" variant="outline" onClick={() => setEditing(null)}>
              Add host
            </Button>
          </div>
        ) : (
          <HostMappingForm
            key={editing ?? "new"}
            initialHost={editing ?? ""}
            initialValue={editing ? saved[editing] : undefined}
            otherHosts={Object.keys(saved).filter((host) => host !== editing)}
            onSave={(host, value) => void save(host, value, editing)}
            onCancel={() => setEditing(undefined)}
          />
        )}
      </fieldset>
    </SettingsSection>
  );
}

function HostMappingForm({
  initialHost,
  initialValue,
  otherHosts,
  onSave,
  onCancel,
}: {
  readonly initialHost: string;
  readonly initialValue: SourceControlHostOverride | undefined;
  readonly otherHosts: readonly string[];
  readonly onSave: (host: string, value: SourceControlHostOverride) => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [host, setHost] = useState(initialHost);
  const [kind, setKind] = useState<SourceControlHostOverride["kind"]>(
    initialValue?.kind ?? "forgejo",
  );
  const [baseUrl, setBaseUrl] = useState(initialValue?.baseUrl ?? "");
  const normalizedHost = host.trim().toLowerCase();
  const value = { kind, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) };
  const validHost = isHostName(normalizedHost);
  const duplicate = otherHosts.some((other) => other.toLowerCase() === normalizedHost);
  const validValue = isHostOverride(value);

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (validHost && !duplicate && validValue) onSave(normalizedHost, value);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-host`}>Hostname</Label>
          <Input
            id={`${id}-host`}
            size="sm"
            autoComplete="off"
            placeholder="code.example.com"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            aria-invalid={host.length > 0 && (!validHost || duplicate)}
            aria-describedby={`${id}-host-help`}
          />
          <p id={`${id}-host-help`} className="text-xs text-muted-foreground">
            {duplicate
              ? "A mapping already exists for this host."
              : "Exact hostname, optionally with a port. No scheme or path."}
          </p>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-kind`}>Provider</Label>
          <Select
            value={kind}
            onValueChange={(next) => {
              if (isProviderKind(next)) setKind(next);
            }}
          >
            <SelectTrigger id={`${id}-kind`} size="sm">
              <SelectValue>
                {(selected: string) => sourceControlClients.get(selected).label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {sourceControlClients.definitions
                .filter((definition) => isProviderKind(definition.kind))
                .map((definition) => (
                  <SelectItem key={definition.kind} value={definition.kind}>
                    {definition.label}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-base-url`}>Base URL (optional)</Label>
        <Input
          id={`${id}-base-url`}
          size="sm"
          autoComplete="off"
          placeholder="https://code.example.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          aria-invalid={!validValue}
          aria-describedby={`${id}-base-help`}
        />
        <p id={`${id}-base-help`} className="text-xs text-muted-foreground">
          HTTP or HTTPS server URL, including its port or subpath if needed. Defaults to the
          remote's HTTP origin, or HTTPS for SSH remotes.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" type="submit" disabled={!validHost || duplicate || !validValue}>
          Save mapping
        </Button>
      </div>
    </form>
  );
}
