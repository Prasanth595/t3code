import { uuidv4 } from "../../lib/uuid";
import * as Dialog from "../../components/ui/Dialog";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { AuthFilesystemReadScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "../../state/vcs";
import { useVcsActionState } from "../../state/use-vcs-action-state";
import { ThreadHeader } from "./ThreadHeader";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "../../state/use-remote-environment-registry";

export function DraftThreadHeader(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
  readonly cwd: string | null;
}) {
  const navigation = useNavigation();
  const { themeVariables } = useAppearancePreferences();
  const environmentId = props.thread.environmentId;
  const environment = useSavedRemoteConnection(environmentId);
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWriteGit = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const status = useEnvironmentQuery(
    props.cwd ? vcsEnvironment.status({ environmentId, input: { cwd: props.cwd } }) : null,
  );
  const target = { environmentId, cwd: props.cwd };
  const progress = useVcsActionState(target);
  const runAction = useAtomCommand(vcsActionManager.runStackedAction(target), {
    reportFailure: false,
  });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const openFiles = () => {
    if (!props.cwd || !canReadFiles) return;
    navigation.navigate("NewTaskFiles", {
      environmentId,
      cwd: props.cwd,
      projectName: props.project.title,
    });
  };
  const requiresThread = () =>
    Dialog.alert("Available after the first message", "This action needs a saved thread.");
  return (
    <ThreadHeader
      draft
      title="New thread"
      subtitle=""
      workspace={{
        projectTitle: props.project.title,
        projectId: props.project.id,
        workspaceRoot: props.project.workspaceRoot,
        environmentLabel: environment?.environmentLabel ?? "Environment",
        connectionState: runtime?.connectionState ?? "available",
        cwd: props.cwd,
        worktreePath: props.thread.worktreePath,
      }}
      headerColor={themeVariables["--color-header"]}
      usesNativeHeaderGlass={NATIVE_LIQUID_GLASS_SUPPORTED}
      hasThreadCwd={props.cwd !== null}
      hasWorkspaceRoot={Boolean(props.project.workspaceRoot)}
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={openFiles}
      onOpenFilesInspector={openFiles}
      onOpenGitInspector={requiresThread}
      gitControls={{
        environmentId,
        threadId: props.thread.id,
        hasThread: false,
        currentBranch: props.thread.branch,
        gitStatus: status.data,
        gitOperationLabel: progress.currentLabel,
        canOpenTerminal: false,
        canOperateTerminal: false,
        canOpenFiles: canReadFiles && props.cwd !== null,
        projectScripts: resolveProjectScripts(
          runtime?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
          props.project,
        ),
        terminalSessions: [],
        onOpenFilesInspector: openFiles,
        onOpenGitInspector: requiresThread,
        onOpenTerminal: requiresThread,
        onOpenNewTerminal: requiresThread,
        onRunProjectScript: async () => {
          requiresThread();
        },
        onPull: async () => {
          if (!canWriteGit || !props.cwd) return;
          const result = await pull({ environmentId, input: { cwd: props.cwd } });
          if (AsyncResult.isFailure(result))
            Dialog.alert("Could not pull", String(Cause.squash(result.cause)));
        },
        onRunAction: async (input) => {
          if (!canWriteGit || !props.cwd) return null;
          const result = await runAction({ ...input, actionId: uuidv4() });
          if (AsyncResult.isFailure(result)) {
            Dialog.alert("Git action failed", String(Cause.squash(result.cause)));
            return null;
          }
          return result.value;
        },
      }}
    />
  );
}
