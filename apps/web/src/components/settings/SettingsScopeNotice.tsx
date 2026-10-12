import { environmentDisplayLabel } from "@t3tools/client-runtime/state/environment-label";
import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import type { SettingsScopeSearch } from "./settingsScope";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

/** Offer an explicit target change when a category has no settings at this scope. */
export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  // Every environment's checkouts, so the notice can always offer another one.
  const { selectScope, search, allGroups: groups } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const choices: { label: string; search: SettingsScopeSearch }[] =
    target === "checkout"
      ? groups
          .filter((group) => !search.project || group.projectKey === search.project)
          .flatMap((group) =>
            group.memberProjects.map((member) => ({
              label: `${group.displayName} · ${member.environmentLabel ?? "Environment"} · ${member.workspaceRoot}`,
              search: {
                project: group.projectKey,
                machine: member.environmentId,
                checkout: member.physicalProjectKey,
              },
            })),
          )
      : target === "project"
        ? groups.map((group) => ({
            label: group.displayName,
            search: { project: group.projectKey },
          }))
        : target === "environment"
          ? environments
              .filter(
                (entry) =>
                  eligibleEnvironmentIds === undefined ||
                  eligibleEnvironmentIds.includes(entry.environmentId),
              )
              .map((entry) => ({
                label: environmentDisplayLabel(entry, environments, primaryEnvironmentId),
                search: { machine: entry.environmentId },
              }))
          : [{ label: "Open all environments", search: {} }];
  return (
    <SettingsPageContainer>
      <Alert role="status">
        <AlertDescription>
          <p>{children}</p>
          <AlertAction className="flex-wrap">
            {choices.map((choice) => (
              <Button
                key={JSON.stringify(choice.search)}
                size="sm-multiline"
                variant="outline"
                className="max-w-full break-all text-left"
                onClick={() => {
                  if (targetId)
                    void navigate({ to: pathname, search: () => choice.search, hash: targetId });
                  else selectScope(choice.search);
                }}
              >
                {choice.label}
              </Button>
            ))}
          </AlertAction>
        </AlertDescription>
      </Alert>
    </SettingsPageContainer>
  );
}
