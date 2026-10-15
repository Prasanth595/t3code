import { useRef } from "react";
import type {
  PullRequestAuthorAssociation,
  PullRequestWatchRemarkFilter,
} from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** The roles offered as toggles. Other roles in settings.json stay as they are. */
const OFFERED_ROLES = [
  ["OWNER", "Owner"],
  ["MEMBER", "Member"],
  ["COLLABORATOR", "Collaborator"],
] as const satisfies ReadonlyArray<readonly [PullRequestAuthorAssociation, string]>;

const isOfferedRole = (value: string) => OFFERED_ROLES.some(([role]) => role === value);

/** Splits "a, b" into logins, without blanks or repeats. */
const parseLogins = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((login) => login.trim())
      .filter((login) => login.length > 0),
  ),
];

/**
 * Fork: which remarks on a watched pull request wake its agent. Lives on the server, so every
 * client of the environment edits the same filter.
 */
export function PullRequestWatchSettingsSection() {
  return (
    <SettingsSection id="pull-request-watch" title="Pull request watch">
      <PullRequestWatchSettingsRows />
    </SettingsSection>
  );
}

/** Fork: the three rows of `pullRequestWatchRemarkFilter`. */
export function PullRequestWatchSettingsRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const loginsEdited = useRef(false);
  const markerEdited = useRef(false);
  const filter = settings.pullRequestWatchRemarkFilter;
  // The filter is one object; each row only cares about its own field.
  const fieldMixed = (field: keyof PullRequestWatchRemarkFilter) => {
    const first = targets[0];
    const value = JSON.stringify(first?.settings.pullRequestWatchRemarkFilter[field]);
    return targets.some(
      (candidate) =>
        JSON.stringify(candidate.settings.pullRequestWatchRemarkFilter[field]) !== value,
    );
  };
  const rolesMixed = fieldMixed("authorAssociations");
  const loginsMixed = fieldMixed("authorLogins");
  const markerMixed = fieldMixed("agentMarker");
  const logins = filter.authorLogins.join(", ");

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchRemarkFilter"]}
        mixed={rolesMixed}
        {...searchableSetting("pull-request-watch-roles")}
        description="A remark wakes a watching agent only when its author has one of these roles on the repository or is a listed login. With no role and no login, any remark wakes it except one from this server's own GitHub account."
        resetAction={
          rolesMixed || filter.authorAssociations.length > 0 ? (
            <SettingResetButton
              label="roles that wake agents"
              onClick={() =>
                updateSettings({
                  pullRequestWatchRemarkFilter: { authorAssociations: [] },
                })
              }
            />
          ) : null
        }
        control={
          <ToggleGroup
            multiple
            aria-label="Roles that wake agents"
            value={rolesMixed ? [] : filter.authorAssociations.filter(isOfferedRole)}
            onValueChange={(value) => {
              const offered = OFFERED_ROLES.flatMap(([role]) =>
                value.includes(role) ? [role] : [],
              );
              const kept = rolesMixed
                ? []
                : filter.authorAssociations.filter((role) => !isOfferedRole(role));
              updateSettings({
                pullRequestWatchRemarkFilter: {
                  authorAssociations: [...kept, ...offered],
                },
              });
            }}
          >
            {OFFERED_ROLES.map(([role, label]) => (
              <Toggle key={role} value={role}>
                {label}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchRemarkFilter"]}
        mixed={loginsMixed}
        {...searchableSetting("pull-request-watch-logins")}
        description="GitHub logins whose remarks wake a watching agent whatever their role. Separate them with commas."
        resetAction={
          loginsMixed || filter.authorLogins.length > 0 ? (
            <SettingResetButton
              label="logins that wake agents"
              onClick={() =>
                updateSettings({
                  pullRequestWatchRemarkFilter: { authorLogins: [] },
                })
              }
            />
          ) : null
        }
        control={
          <Input
            key={`${scopeKey}:${loginsMixed}:${logins}`}
            aria-label="Logins that wake agents"
            autoCapitalize="none"
            spellCheck={false}
            onChange={() => {
              loginsEdited.current = true;
            }}
            placeholder={loginsMixed ? "Mixed" : "octocat, hubot"}
            defaultValue={loginsMixed ? "" : logins}
            onBlur={(event) => {
              const next = parseLogins(event.target.value);
              if (loginsEdited.current && (loginsMixed || next.join(", ") !== logins))
                updateSettings({
                  pullRequestWatchRemarkFilter: { authorLogins: next },
                });
              loginsEdited.current = false;
            }}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchRemarkFilter"]}
        mixed={markerMixed}
        {...searchableSetting("pull-request-watch-agent-marker")}
        description="A remark that contains this text never wakes a watching agent, even from an allowed author. Agents add it to their own remarks."
        resetAction={
          markerMixed || filter.agentMarker !== "" ? (
            <SettingResetButton
              label="agent remark marker"
              onClick={() =>
                updateSettings({
                  pullRequestWatchRemarkFilter: { agentMarker: "" },
                })
              }
            />
          ) : null
        }
        control={
          <Input
            key={`${scopeKey}:${markerMixed}:${filter.agentMarker}`}
            aria-label="Agent remark marker"
            autoCapitalize="none"
            spellCheck={false}
            onChange={() => {
              markerEdited.current = true;
            }}
            placeholder={markerMixed ? "Mixed" : "<!-- agent -->"}
            defaultValue={markerMixed ? "" : filter.agentMarker}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (markerEdited.current && (markerMixed || value !== filter.agentMarker))
                updateSettings({
                  pullRequestWatchRemarkFilter: { agentMarker: value },
                });
              markerEdited.current = false;
            }}
          />
        }
      />
    </>
  );
}
