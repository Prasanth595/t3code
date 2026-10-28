import { useAtomValue } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  ProjectScriptIcon,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { uuidv4 } from "../../lib/uuid";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { replaceProjectAction } from "./thread-project-actions";

export function ThreadProjectActions(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string | null;
  readonly scripts: readonly ProjectScript[];
  readonly canRun: boolean;
  readonly onRun: (script: ProjectScript) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canEdit = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const canReadFiles = useEnvironmentScope(props.environmentId, AuthFilesystemReadScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "save project actions");
  const file = useEnvironmentQuery(
    props.cwd && canReadFiles
      ? projectEnvironment.readFile({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, relativePath: T3_PROJECT_FILE_NAME },
        })
      : null,
  );
  const fileScripts =
    file.data?.exists && !file.data.truncated
      ? (parseT3ProjectFile(file.data.contents)?.scripts ?? [])
      : [];
  const importable = fileScripts.filter(
    (script) =>
      !props.scripts.some(
        (existing) =>
          existing.command === script.command ||
          existing.name.toLowerCase() === script.name.toLowerCase(),
      ),
  );
  const [editor, setEditor] = useState<ProjectScript | null>(null);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);

  const persist = async (scripts: readonly ProjectScript[]) => {
    if (!config || !canEdit || saving.current) return false;
    saving.current = true;
    setPending(true);
    try {
      const result = await updateSettings({
        environmentId: props.environmentId,
        input: {
          patch:
            config.environment.capabilities.projectSettingsOverrides === true
              ? {
                  projectSettingsOverrides: {
                    [props.projectId]: {
                      ...config.settings.projectSettingsOverrides[props.projectId],
                      defaultProjectScripts: scripts,
                    },
                  },
                }
              : { projectScriptOverrides: { [props.projectId]: scripts } },
        },
      });
      return result._tag === "Success";
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  const save = async () => {
    if (!editor || !editor.name.trim() || !editor.command.trim()) return;
    const { previewUrl, ...rest } = editor;
    const saved: ProjectScript = {
      ...rest,
      name: editor.name.trim(),
      command: editor.command.trim(),
      ...(previewUrl?.trim() ? { previewUrl: previewUrl.trim() } : {}),
    };
    if (await persist(replaceProjectAction(props.scripts, saved))) setEditor(null);
  };

  return (
    <View className="gap-3">
      <ListSection
        title="Project actions"
        footer={
          !props.canRun ? "Running actions requires a saved thread and terminal access." : undefined
        }
      >
        {props.scripts.map((script) => (
          <View key={script.id} className="flex-row items-center">
            <View className="min-w-0 flex-1">
              <ListRow
                icon="play"
                label={projectScriptMenuLabel(script)}
                description={script.command}
                disabled={!props.canRun || pending}
                onPress={() => props.onRun(script)}
              />
            </View>
            {canEdit ? (
              <View className="pr-2">
                <IconButton
                  icon="pencil"
                  accessibilityLabel={`Edit ${script.name}`}
                  disabled={pending}
                  onPress={() => setEditor(script)}
                />
              </View>
            ) : null}
          </View>
        ))}
        {props.scripts.length === 0 ? (
          <Text textRole="footnote" className="px-4 py-4 text-foreground-muted">
            No project actions configured.
          </Text>
        ) : null}
        {importable.map((script) => (
          <ListRow
            key={`${script.name}:${script.command}`}
            icon="arrow.down.circle"
            label={`Import ${script.name}`}
            description={`From t3.json · ${script.command}`}
            disabled={!canEdit || pending}
            onPress={() =>
              void persist(
                replaceProjectAction(props.scripts, {
                  ...script,
                  id: uuidv4(),
                  icon: script.icon ?? "play",
                  runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
                }),
              )
            }
          />
        ))}
        <ListRow
          icon="plus"
          label="Add project action"
          disabled={!canEdit || pending}
          onPress={() =>
            setEditor({
              id: uuidv4(),
              name: "",
              command: "",
              icon: "play",
              runOnWorktreeCreate: false,
            })
          }
        />
      </ListSection>
      {editor ? (
        <View className="gap-3 rounded-2xl bg-grouped-card p-4">
          <Text textRole="headline">
            {props.scripts.some((script) => script.id === editor.id) ? "Edit action" : "New action"}
          </Text>
          <TextInput
            accessibilityLabel="Action name"
            placeholder="Action name"
            value={editor.name}
            editable={!pending && canEdit}
            onChangeText={(name) => setEditor({ ...editor, name })}
          />
          <TextInput
            accessibilityLabel="Action command"
            placeholder="Command"
            value={editor.command}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending && canEdit}
            onChangeText={(command) => setEditor({ ...editor, command })}
          />
          <View className="flex-row flex-wrap gap-2">
            {ProjectScriptIcon.literals.map((icon) => (
              <Pressable
                key={icon}
                accessibilityRole="radio"
                accessibilityLabel={`${icon} action icon`}
                accessibilityState={{ checked: editor.icon === icon }}
                disabled={pending || !canEdit}
                onPress={() => setEditor({ ...editor, icon })}
                className={
                  editor.icon === icon
                    ? "rounded-lg bg-secondary px-3 py-2"
                    : "rounded-lg bg-subtle px-3 py-2"
                }
              >
                <Text textRole="footnote">{icon}</Text>
              </Pressable>
            ))}
          </View>
          <ActionToggle
            label="Run on worktree creation"
            value={editor.runOnWorktreeCreate}
            disabled={pending || !canEdit}
            onChange={(value) => setEditor({ ...editor, runOnWorktreeCreate: value })}
          />
          {editor.runOnWorktreeCreate ? (
            <ActionToggle
              label="Wait for setup before starting the agent"
              value={editor.async === false}
              disabled={pending || !canEdit}
              onChange={(value) => setEditor({ ...editor, async: !value })}
            />
          ) : null}
          <ActionToggle
            label="Run when the thread settles"
            value={editor.runOnSettle === true}
            disabled={pending || !canEdit}
            onChange={(value) => setEditor({ ...editor, runOnSettle: value })}
          />
          <TextInput
            accessibilityLabel="Action preview URL"
            placeholder="Preview URL (optional)"
            value={editor.previewUrl ?? ""}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending && canEdit}
            onChangeText={(previewUrl) => setEditor({ ...editor, previewUrl })}
          />
          {editor.previewUrl?.trim() ? (
            <ActionToggle
              label="Open preview after running"
              value={editor.autoOpenPreview === true}
              disabled={pending || !canEdit}
              onChange={(value) => setEditor({ ...editor, autoOpenPreview: value })}
            />
          ) : null}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button
                label={pending ? "Saving…" : "Save action"}
                disabled={pending || !canEdit || !editor.name.trim() || !editor.command.trim()}
                onPress={() => void save()}
              />
            </View>
            <Button
              label="Cancel"
              tone="secondary"
              disabled={pending}
              onPress={() => setEditor(null)}
            />
          </View>
          {props.scripts.some((script) => script.id === editor.id) ? (
            <Button
              label="Delete action"
              tone="danger"
              disabled={pending || !canEdit}
              onPress={() =>
                Dialog.confirm({
                  title: `Delete ${editor.name}?`,
                  message: "This removes the action from this project, not its files.",
                  confirmText: "Delete action",
                  destructive: true,
                  onConfirm: () => {
                    void persist(props.scripts.filter((script) => script.id !== editor.id)).then(
                      (saved) => {
                        if (saved) setEditor(null);
                      },
                    );
                  },
                })
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ActionToggle(props: {
  readonly label: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text textRole="footnote" className="min-w-0 flex-1">
        {props.label}
      </Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onChange}
      />
    </View>
  );
}
