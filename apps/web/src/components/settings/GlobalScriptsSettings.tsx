import { AuthSettingsWriteScope, type ProjectScript } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { PlusIcon } from "lucide-react";
import { mapAtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { buildProjectScript, nextProjectScriptId } from "../../projectScripts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { ProjectActionsList } from "./ProjectActionsList";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettingsWriteAllowed } from "./useScopedSettings";

/**
 * Scripts available in every project of the selected environments. Shown at
 * environment scope only, because they belong to the environment.
 */
export function GlobalScriptsSettings() {
  const { scope, target } = useSettingsScope();
  if (scope.kind === "project" || scope.kind === "checkout" || !target) return null;
  return (
    <SettingsSection title="Global scripts">
      <GlobalScriptsSettingsRows />
    </SettingsSection>
  );
}

export function GlobalScriptsSettingsRows() {
  const { scope, targets, target } = useSettingsScope();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "global scripts update");
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const [saving, setSaving] = useState(false);
  if (scope.kind === "project" || scope.kind === "checkout" || !target) return null;

  const scripts = target.settings.globalScripts;
  const mixed = targets.some(
    (candidate) => JSON.stringify(candidate.settings.globalScripts) !== JSON.stringify(scripts),
  );

  async function persist(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[],
    removedId: string | null = null,
  ): Promise<ProjectScriptActionResult> {
    setSaving(true);
    try {
      for (const candidate of targets) {
        const result = await updateSettings({
          environmentId: candidate.environmentId,
          input: {
            patch: {
              globalScripts: transform(candidate.settings.globalScripts),
              // A deleted script loses its pin in the same write.
              ...(removedId !== null && candidate.settings.pinnedGlobalScriptIds.includes(removedId)
                ? {
                    pinnedGlobalScriptIds: candidate.settings.pinnedGlobalScriptIds.filter(
                      (id) => id !== removedId,
                    ),
                  }
                : {}),
            },
          },
        });
        if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
      }
      return AsyncResult.success(undefined);
    } finally {
      setSaving(false);
    }
  }

  function submit(scriptId: string | null, input: NewProjectScriptInput) {
    const id =
      scriptId ??
      nextProjectScriptId(
        input.name,
        targets.flatMap((candidate) => candidate.settings.globalScripts.map((script) => script.id)),
      );
    // Global scripts run on demand only, so the lifecycle roles stay off.
    const next = buildProjectScript(id, {
      ...input,
      runOnWorktreeCreate: false,
      waitForSetup: false,
      runOnSettle: false,
    });
    return persist((current) =>
      scriptId === null
        ? [...current, next]
        : current.map((script) => (script.id === scriptId ? next : script)),
    );
  }

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["globalScripts"]}
        mixed={mixed}
        {...searchableSetting("global-scripts")}
        description="Commands available in every project. They run in the thread's worktree, or else the project folder. Right-click the sidebar toggle or the chat header to pin them."
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={saving || !canWriteSettings}
            onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
          >
            <PlusIcon className="size-3.5" />
            Add global script
          </Button>
        }
      />
      {mixed ? (
        <SettingsRow
          title="Different global scripts across environments"
          description="Choose one environment to edit its list. Adding a script here adds it on every selected environment."
        />
      ) : (
        <ProjectActionsList
          scripts={scripts}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          disabled={saving || !canWriteSettings}
          onEdit={(script) =>
            setRequest(editorRequestForScript(script, DEFAULT_RESOLVED_KEYBINDINGS))
          }
        />
      )}
      <ProjectScriptEditorDialog
        environmentId={target.environmentId}
        editScope={AuthSettingsWriteScope}
        global
        request={request}
        scripts={scripts}
        onSubmit={submit}
        onDelete={(id) =>
          void persist((current) => current.filter((script) => script.id !== id), id)
        }
        onClose={() => setRequest(null)}
      />
    </>
  );
}
