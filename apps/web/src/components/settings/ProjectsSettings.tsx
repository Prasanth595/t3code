import { AuthOrchestrationOperateScope, EnvironmentId } from "@t3tools/contracts";
import { DownloadIcon, LayersIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { ImportProjectsDialog } from "./ImportProjectsDialog";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";

export function ProjectsSettings() {
  const { search: value, scope, selectScope } = useSettingsScope();
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              Show all environments
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <SettingsPageContainer>
          <ImportProjectsSection />
          <SettingsScopeNotice inline target="project">
            Choose a project to manage its name, icon, checkouts and actions.
          </SettingsScopeNotice>
        </SettingsPageContainer>
      )}
    </div>
  );
}

function ImportProjectsSection() {
  const { connectedEnvironments } = useSettingsScope();
  const writableIds = useEnvironmentsWithScope(
    connectedEnvironments,
    AuthOrchestrationOperateScope,
  );
  const environmentIds = connectedEnvironments
    .map((environment) => environment.environmentId)
    .filter((environmentId) => writableIds.has(environmentId));
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title="Import">
      <SettingsRow
        id="import-projects"
        title="Import from Claude Code and Codex"
        description="Add projects and conversation history from Claude Code and Codex. Projects that are already in T3 Code pick up any new conversations."
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={environmentIds.length === 0}
            onClick={() => setOpen(true)}
          >
            <DownloadIcon />
            Import projects
          </Button>
        }
      />
      {open ? (
        <ImportProjectsDialog environmentIds={environmentIds} onClose={() => setOpen(false)} />
      ) : null}
    </SettingsSection>
  );
}
