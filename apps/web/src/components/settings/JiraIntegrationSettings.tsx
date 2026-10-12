import { useAtomValue } from "@effect/atom-react";
import type { IssueTrackerProjectBinding } from "@t3tools/contracts";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { issueTrackingEnvironment } from "../../state/issueTracking";
import { issueEnvironment } from "../../state/issues";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AtlassianIcon } from "../Icons";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";

const UNMAPPED = "__unmapped__";

const EMPTY_BINDINGS: Readonly<Record<string, IssueTrackerProjectBinding | null>> = {};

/**
 * Jira reads through the Atlassian TWG CLI's own login on the server, so there is no account to
 * add here: the row reports that login and each T3 project picks the Jira project it reads.
 */
export function JiraIntegrationSettings() {
  const { environment } = useSettingsScope();
  return <JiraIntegrationRows key={environment?.environmentId} environment={environment} />;
}

function JiraIntegrationRows({ environment }: { environment: EnvironmentPresentation | null }) {
  const supported = environment?.serverConfig?.environment.capabilities.issues === true;
  const environmentId = supported ? environment.environmentId : null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectBindings =
    useScopedSettings((settings) => settings.issueTracking.connections.jira?.projectBindings) ??
    EMPTY_BINDINGS;
  const connection = useEnvironmentQuery(
    environmentId === null
      ? null
      : issueTrackingEnvironment.status({ environmentId, input: { provider: "jira" } }),
  );
  const saveProjectBinding = useAtomCommand(issueTrackingEnvironment.bind, {
    reportFailure: false,
  });
  const canBind = useAtomValue(issueTrackingEnvironment.bind.permissionAtom(environmentId));
  const invalidate = useAtomCommand(issueEnvironment.invalidate);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const jira = connection.data;
  const signedIn = jira?.status === "authenticated";
  const options = (jira?.projects ?? []).map((project) => ({
    value: project.key,
    label: `${project.name} (${project.key.split("/").at(-1)})`,
  }));

  const setProjectBinding = async (
    projectId: (typeof projects)[number]["id"],
    repository: string | null,
  ) => {
    if (environmentId === null || !canBind) return;
    setBusy(true);
    setActionError(null);
    const result = await saveProjectBinding({
      environmentId,
      input: {
        provider: "jira",
        projectId,
        binding: repository === null ? null : { repository },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setActionError(formatEnvironmentQueryError(result.cause));
      return;
    }
    void invalidate({ environmentId, input: {} });
  };

  const error = actionError ?? connection.error;
  const description = !supported
    ? "Connect to a server that supports issues to set up Jira."
    : connection.isPending && !jira
      ? "Checking the Atlassian TWG CLI…"
      : signedIn
        ? "Read through the Atlassian TWG CLI on this server."
        : "Install the Atlassian TWG CLI on this server and run `twg login`.";

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <AtlassianIcon className="size-4" />
          Jira
        </span>
      }
      description={description}
      control={
        supported ? (
          <Button
            size="sm"
            variant="outline"
            disabled={connection.isPending}
            onClick={connection.refresh}
          >
            Check again
          </Button>
        ) : null
      }
    >
      {supported && (error || signedIn) ? (
        <div className="space-y-2 py-3">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {signedIn ? (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
                <RedactedSensitiveText
                  value={jira.accountName}
                  ariaLabel="Toggle Atlassian account name visibility"
                  revealTooltip="Click to reveal account"
                  hideTooltip="Click to hide account"
                  className="max-w-full truncate"
                />
                <span className="truncate text-xs text-muted-foreground">
                  {jira.projects.length === 1 ? "1 project" : `${jira.projects.length} projects`} on{" "}
                  {jira.projects[0]?.key.split("/")[0] ?? "the default site"}
                </span>
              </div>
              <div className="divide-y divide-border/50">
                {projects.map((project) => {
                  const value = projectBindings[project.id]?.repository ?? UNMAPPED;
                  const selected = options.find((option) => option.value === value);
                  const unavailable = value !== UNMAPPED && selected === undefined;
                  return (
                    <div
                      key={project.id}
                      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                    >
                      <span className="min-w-0 truncate text-sm">{project.title}</span>
                      <Select
                        value={value}
                        disabled={!canBind || busy}
                        onValueChange={(next) => {
                          if (!next) return;
                          void setProjectBinding(project.id, next === UNMAPPED ? null : next);
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-full sm:w-64"
                          aria-label={`Jira project for ${project.title}`}
                          aria-invalid={unavailable || undefined}
                        >
                          <SelectValue>
                            {unavailable ? value : (selected?.label ?? "Not connected")}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          <SelectItem value={UNMAPPED}>Not connected</SelectItem>
                          {unavailable ? (
                            <SelectItem value={value} disabled>
                              {value} (not visible to this login)
                            </SelectItem>
                          ) : null}
                          {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  );
                })}
                {projects.length === 0 ? (
                  <p className="py-3 text-sm text-muted-foreground">Add a project first.</p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}
