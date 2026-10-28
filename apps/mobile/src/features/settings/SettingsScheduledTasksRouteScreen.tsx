import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import type {
  EnvironmentId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useFocusEffect, useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AppState, Platform, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  EnvironmentMachineSymbol,
  ENVIRONMENT_MACHINE_SYMBOLS,
} from "../../components/EnvironmentMachineSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { usePreparedConnection } from "../../state/session";
import { buildModelOptions } from "../../lib/modelOptions";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { resolveNewTaskBranchLabel } from "../threads/new-task-context-presentation";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { ScheduledTaskPromptField } from "./components/ScheduledTaskPromptField";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import {
  editDraft,
  scheduledTaskDefaultModel,
  scheduleFromDraft,
  type ScheduledTaskDraft as Draft,
} from "./scheduledTaskDraft";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";
import { useScheduledTaskEditor } from "./scheduled-task-editor";
import { scheduledTaskEditorSessionAtom } from "./scheduled-task-editor-state";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

type ScheduledTaskRoutes = {
  SettingsScheduledTaskNew: undefined;
  SettingsScheduledTaskEdit: undefined;
  SettingsScheduledTaskModel: undefined;
  SettingsScheduledTaskBranch: undefined;
};

const DAYS = [
  { index: 1, label: "Lun" },
  { index: 2, label: "Mar" },
  { index: 3, label: "Mie" },
  { index: 4, label: "Joi" },
  { index: 5, label: "Vin" },
  { index: 6, label: "Sâm" },
  { index: 0, label: "Dum" },
] as const;

function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.type === "webhook") return "La webhook";
  if (task.schedule.type === "interval") return formatScheduledTaskInterval(task.schedule.everyMs);
  const days = task.schedule.weekdays?.length ? repeatLabel(task.schedule.weekdays) : "Zilnic";
  return `${days} la ${formatTime(task.schedule.timeOfDay)}`;
}

function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function timePickerValue(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);
  const time = new Date();
  time.setHours(
    Number.isInteger(hours) ? (hours ?? 9) : 9,
    Number.isInteger(minutes) ? (minutes ?? 0) : 0,
    0,
    0,
  );
  return time;
}

function repeatLabel(weekdays: ReadonlyArray<number>): string {
  const days = new Set(weekdays);
  if (days.size === 7) return "Zilnic";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day)))
    return "În zilele lucrătoare";
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => day.label)
      .join(", ") || "Alege zilele"
  );
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly keyboardType?: "decimal-pad" | "number-pad";
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly borderTop?: boolean;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <RNTextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        textAlignVertical="center"
        keyboardType={props.keyboardType}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly valueIcon?: ReactNode;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
  const value = (
    <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
      {props.valueIcon}
      <Text className="shrink text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  );
  if (props.actions.length === 0) {
    return (
      <View
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
      </View>
    );
  }
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        }
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

function WebhookFilterRows(props: {
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  readonly disabled: boolean;
  readonly onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    props.onChange(
      props.filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)),
    );
  return (
    <>
      {props.filters.map((filter, index) => (
        <View key={filter.id}>
          <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 pt-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted">Filter {index + 1}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Elimină filtrul ${index + 1}`}
              disabled={props.disabled}
              hitSlop={8}
              onPress={() => props.onChange(removeWebhookFilterDraft(props.filters, filter.id))}
              className="active:opacity-70"
            >
              <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
            </Pressable>
          </View>
          <FormField
            label="Cale"
            value={filter.path}
            placeholder="body.action"
            disabled={props.disabled}
            onChange={(path) => update(index, { path })}
          />
          <SelectRow
            label="Condiție"
            value={WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label ?? ""}
            actions={WEBHOOK_FILTER_OPS.map((option) => ({
              id: option.op,
              title: option.label,
              state: option.op === filter.op ? ("on" as const) : undefined,
            }))}
            onSelect={(id) => {
              const known = WEBHOOK_FILTER_OPS.find((option) => option.op === id);
              if (known) update(index, { op: known.op });
            }}
          />
          {filter.op === "exists" ? null : (
            <FormField
              label={filter.op === "in" ? "Valori, separate prin virgulă" : "Valoare"}
              value={filter.value}
              placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
              disabled={props.disabled}
              onChange={(value) => update(index, { value })}
            />
          )}
        </View>
      ))}
      {props.filters.length < MAX_WEBHOOK_FILTERS ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => props.onChange([...props.filters, emptyWebhookFilterDraft()])}
          className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
        >
          <Text className="min-w-0 flex-1 text-lg text-foreground">Adaugă filtru</Text>
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      ) : null}
      {props.filters.length > 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          Rulează doar când toate filtrele se potrivesc. Celelalte cereri sunt înregistrate ca
          filtrate. Separă valorile „este unul din” prin virgulă; o valoare nu poate conține
          virgulă.
        </Text>
      ) : null}
    </>
  );
}

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.value}`}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text className="text-lg text-foreground">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SettingsScheduledTasksRouteScreen() {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(() => {
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = setInterval(updateNow, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") updateNow();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  });
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const visibleEnvironments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const { startEditor, resetEditor } = useScheduledTaskEditor();
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const insets = useSafeAreaInsets();
  const newTask = () => {
    if (visibleEnvironments.length === 0) return;
    resetEditor();
    navigation.navigate("SettingsScheduledTaskNew");
  };

  return (
    <>
      <SettingsEnvironmentFilterHeader
        trailingItems={[
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: "Sarcină nouă",
            icon: { type: "sfSymbol", name: "plus" } as const,
            disabled: visibleEnvironments.length === 0,
            onPress: newTask,
          }),
        ]}
      />
      <SettingsScreen
        title="Sarcini programate"
        trailing={
          <View className="flex-row items-center">
            <AndroidSettingsEnvironmentFilter />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sarcină nouă"
              accessibilityState={{ disabled: visibleEnvironments.length === 0 }}
              disabled={visibleEnvironments.length === 0}
              onPress={newTask}
              className="size-11 items-center justify-center rounded-full disabled:opacity-50"
            >
              <SymbolView name="plus" size={22} tintColorClassName="accent-icon" />
            </Pressable>
          </View>
        }
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {visibleEnvironments.length > 0 ? (
            visibleEnvironments.map((environment) => (
              <EnvironmentTasks
                key={environment.environmentId}
                environment={environment}
                now={now}
                projectIds={
                  selectedProjectKey === null
                    ? null
                    : (selectedGroup?.members
                        .filter(
                          (member) => member.project.environmentId === environment.environmentId,
                        )
                        .map((member) => member.project.id) ?? [])
                }
                onEdit={(task) => {
                  startEditor({
                    environmentId: environment.environmentId,
                    environmentLabel: environment.label,
                    draft: editDraft(task),
                  });
                  navigation.navigate("SettingsScheduledTaskEdit");
                }}
              />
            ))
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Conectează un mediu ca să vezi și să creezi sarcini programate."
                : "Niciun mediu nu corespunde filtrelor. Schimbă filtrul de mai sus."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

export function SettingsScheduledTaskNewRouteScreen() {
  const { resetEditor } = useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (initialized.current || availableTargets.length === 0) return;
    initialized.current = true;
    resetEditor();
  }, [availableTargets.length, resetEditor]);
  return <SettingsScheduledTaskEditorScreen title="Sarcină programată nouă" />;
}

export function SettingsScheduledTaskEditRouteScreen() {
  return <SettingsScheduledTaskEditorScreen title="Editează sarcina programată" />;
}

function SettingsScheduledTaskEditorScreen({ title }: { readonly title: string }) {
  const {
    editor,
    voiceOwnerKey,
    readEditor,
    setEditor,
    startEditor,
    hasChanges,
    draftForEnvironment,
  } = useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ownerKey = editor ? `${voiceOwnerKey}:${editor.environmentId}` : null;
  const prompt = editor?.draft.prompt ?? "";
  const [selectionState, setSelectionState] = useState<{
    readonly ownerKey: string | null;
    readonly selection: ComposerEditorSelection;
  } | null>(null);
  const selection =
    selectionState?.ownerKey === ownerKey
      ? selectionState.selection
      : { start: prompt.length, end: prompt.length };
  const setSelection = (next: ComposerEditorSelection) =>
    setSelectionState({ ownerKey, selection: next });
  const setPrompt = (next: string) =>
    setEditor((current) =>
      current
        ? {
            ...current,
            draft: { ...current.draft, prompt: next },
          }
        : current,
    );
  const voiceInput = useVoiceInputController({
    ownerKey,
    label: editor?.draft.title.trim() || title,
    subscribeToDraftChanges: (onChange) =>
      appAtomRegistry.subscribe(scheduledTaskEditorSessionAtom, onChange),
    selection,
    readDraftMessage: () => {
      const current = readEditor();
      if (current?.environmentId !== editor?.environmentId) return null;
      return current?.draft.prompt ?? null;
    },
    onChangeSelection: setSelection,
    onChangeDraftMessage: (text) => {
      if (readEditor()?.environmentId === editor?.environmentId) setPrompt(text);
    },
    disabled: saving,
  });
  const preventRemove = !saved && (hasChanges || saving);
  usePreventRemove(preventRemove, ({ data }) => {
    if (saving) {
      Dialog.alert("Se salvează sarcina", "Așteaptă să se termine salvarea înainte să ieși.");
      return;
    }
    Dialog.alert("Renunți la modificări?", "Modificările nesalvate se vor pierde.", [
      { text: "Continuă editarea", style: "cancel" },
      {
        text: "Renunță la modificări",
        style: "destructive",
        onPress: () => {
          if (voiceInput.isBusy) voiceInput.cancel();
          startEditor(null);
          navigation.dispatch(data.action);
        },
      },
    ]);
  });
  useEffect(() => {
    if (!saved) return;
    const frame = requestAnimationFrame(() => {
      if (navigation.isFocused()) navigation.goBack();
    });
    return () => cancelAnimationFrame(frame);
  }, [navigation, saved]);
  return (
    <SettingsScreen title={title}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            // Native Back pops before removal guards; a bar action lets the guard run first.
            unstable_headerLeftItems: () => [
              withNativeGlassHeaderItem({
                type: "button",
                label: "",
                accessibilityLabel: "Înapoi",
                icon: { type: "sfSymbol", name: "chevron.backward" },
                onPress: () => navigation.goBack(),
              }),
            ],
          }}
        />
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {editor ? (
          <TaskForm
            key={editor.environmentId}
            environmentId={editor.environmentId}
            environmentLabel={
              availableTargets.find((target) => target.environmentId === editor.environmentId)
                ?.label ?? editor.environmentLabel
            }
            availableTargets={availableTargets}
            draft={editor.draft}
            saving={saving}
            setSaving={setSaving}
            dictationPending={voiceInput.blocksSubmission}
            promptField={
              <ScheduledTaskPromptField
                value={prompt}
                onChange={setPrompt}
                selection={selection}
                onChangeSelection={setSelection}
                disabled={saving}
                voiceInput={voiceInput}
              />
            }
            setDraft={(draft) => {
              if (!saving) setEditor({ ...editor, draft });
            }}
            onSaved={() => setSaved(true)}
            onChangeEnvironment={(target) => {
              if (target.environmentId === editor.environmentId) return;
              setEditor({
                environmentId: target.environmentId,
                environmentLabel: target.label,
                draft: {
                  ...draftForEnvironment(target.environmentId),
                  title: editor.draft.title,
                  prompt: editor.draft.prompt,
                  schedule: editor.draft.schedule,
                  enabled: editor.draft.enabled,
                },
              });
            }}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Conectează un mediu ca să creezi o sarcină programată."
              : "Niciun mediu nu corespunde filtrelor. Schimbă filtrele ca să creezi o sarcină."}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function TaskForm({
  environmentId,
  environmentLabel,
  availableTargets,
  draft,
  saving,
  setSaving,
  dictationPending,
  promptField,
  setDraft,
  onSaved,
  onChangeEnvironment,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly availableTargets: readonly SettingsTarget[];
  readonly draft: Draft;
  readonly saving: boolean;
  readonly setSaving: (saving: boolean) => void;
  readonly dictationPending: boolean;
  readonly promptField: ReactNode;
  readonly setDraft: (draft: Draft) => void;
  readonly onSaved: () => void;
  readonly onChangeEnvironment: (target: SettingsTarget) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const config = useEnvironmentServerConfig(environmentId);
  const modelOptions = buildModelOptions(config, null, undefined, draft.projectId);
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
    reportFailure: false,
  });
  const submissionPending = useRef(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const taskMissing =
    draft.task !== null &&
    tasks.data !== null &&
    !tasks.data.tasks.some((task) => task.id === draft.task?.id);
  const environmentUnavailable = !availableTargets.some(
    (target) => target.environmentId === environmentId,
  );

  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const save = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      dictationPending ||
      taskMissing ||
      environmentUnavailable
    )
      return;
    // Preserve signatures edited on other clients by sending the task's current value.
    const liveTask = tasks.data?.tasks.find((task) => task.id === draft.task?.id);
    const schedule = scheduleFromDraft(
      draft.schedule.mode === "webhook" && liveTask?.schedule.type === "webhook"
        ? { ...draft.schedule, signature: liveTask.schedule.signature }
        : draft.schedule,
    );
    if (
      draft.schedule.mode === "webhook" &&
      parseMaxDeliveryAge(draft.schedule.maxDeliveryAgeMinutes) === undefined
    ) {
      Dialog.alert(
        "Limită de vechime invalidă",
        `Introdu un număr întreg de minute între 1 și ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES} sau lasă gol.`,
      );
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.schedule.filters);
    if (draft.schedule.mode === "webhook" && "error" in parsedFilters) {
      Dialog.alert("Filtru invalid", parsedFilters.error);
      return;
    }
    if (draft.schedule.mode === "webhook" && schedule === null) {
      Dialog.alert(
        "Setări webhook invalide",
        "Fiecare cheie de deduplicare trebuie să conțină un placeholder valid. Fereastra de comasare trebuie să fie un număr întreg de secunde între 10 și 3600 sau goală.",
      );
      return;
    }
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !draft.projectId ||
      !draft.modelSelection ||
      !schedule ||
      (draft.workspace === "existing_worktree" && !draft.checkoutPath.trim())
    ) {
      Dialog.alert(
        "Sarcină incompletă",
        "Adaugă un nume, un prompt, un proiect, un model, un program valid și calea checkout-ului dacă e nevoie.",
      );
      return;
    }
    if (!projects.some((project) => project.id === draft.projectId)) {
      Dialog.alert("Proiect indisponibil", "Alege un proiect din acest mediu.");
      return;
    }
    const input: ScheduledTaskUpsertInput = {
      ...(draft.task ? { id: draft.task.id, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      projectId: draft.projectId,
      modelSelection: draft.modelSelection,
      schedule,
      enabled: draft.enabled,
      threadId: draft.task?.threadId ?? null,
      workspaceStrategy:
        draft.workspace === "root"
          ? { type: "root" }
          : draft.workspace === "existing_worktree"
            ? { type: "existing_worktree", worktreePath: draft.checkoutPath.trim() }
            : {
                type: "worktree",
                baseRef: draft.baseRef.trim() || "main",
                startFromOrigin: draft.startFromOrigin,
              },
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.task?.interactionMode ?? "default",
      creationSource: draft.task?.creationSource ?? "mobile",
    };
    submissionPending.current = true;
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      failure("Sarcina nu a putut fi salvată", result);
      return;
    }
    onSaved();
  };

  return (
    <View className="gap-5">
      <View
        className="gap-5"
        pointerEvents={saving ? "none" : "auto"}
        accessibilityElementsHidden={saving}
        importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
      >
        {taskMissing ? (
          <Text className="px-1 text-base text-danger-foreground">
            Această sarcină nu mai există.
          </Text>
        ) : null}

        {environmentUnavailable ? (
          <Text className="px-1 text-base text-danger-foreground">
            Acest mediu este deconectat. Reconectează-te înainte să salvezi.
          </Text>
        ) : null}
        <SettingsSection>
          <SelectRow
            label="Rulează pe"
            value={environmentLabel}
            valueIcon={
              <EnvironmentMachineSymbol
                kind={resolveEnvironmentMachineKind(config)}
                size={18}
                tintColorClassName="accent-foreground-muted"
              />
            }
            actions={
              draft.task || saving || dictationPending
                ? []
                : availableTargets.map((target) => ({
                    id: target.environmentId,
                    title: target.label,
                    image:
                      ENVIRONMENT_MACHINE_SYMBOLS[
                        resolveEnvironmentMachineKind(target.serverConfig)
                      ],
                    state: target.environmentId === environmentId ? "on" : undefined,
                  }))
            }
            onSelect={(id) => {
              const target = availableTargets.find((entry) => entry.environmentId === id);
              if (target) onChangeEnvironment(target);
            }}
          />
        </SettingsSection>
        <SettingsSection title="Sarcină">
          <FormField
            label="Nume"
            disabled={saving}
            value={draft.title}
            placeholder="Verifică problemele"
            onChange={(title) => setDraft({ ...draft, title })}
          />
          {promptField}
        </SettingsSection>

        <SettingsSection title="Context">
          <SelectRow
            label="Proiect"
            value={
              projects.find((project) => project.id === draft.projectId)?.title ??
              (projects.length ? "Alege proiectul" : "Niciun proiect disponibil")
            }
            actions={projects.map((project) => ({
              id: project.id,
              title: project.title,
              state: project.id === draft.projectId ? "on" : undefined,
            }))}
            onSelect={(id) => {
              const project = projects.find((item) => item.id === id);
              if (!project) return;
              const keepsExplicitModel =
                draft.modelSelectionIsExplicit &&
                (draft.modelSelection === null ||
                  !config?.settings ||
                  resolveProjectProviderInstanceEnabled(
                    config.settings,
                    project.id,
                    draft.modelSelection.instanceId,
                  ));
              setDraft({
                ...draft,
                projectId: project.id,
                modelSelection: keepsExplicitModel
                  ? draft.modelSelection
                  : scheduledTaskDefaultModel(config, project),
                modelSelectionIsExplicit: keepsExplicitModel,
              });
            }}
          />
          <PickerRow
            label="Model"
            borderTop
            value={
              modelOptions.find(
                (option) =>
                  option.selection.instanceId === draft.modelSelection?.instanceId &&
                  option.selection.model === draft.modelSelection?.model,
              )?.label ??
              draft.modelSelection?.model ??
              (modelOptions.length ? "Alege modelul" : "Niciun model disponibil")
            }
            onPress={() => navigation.navigate("SettingsScheduledTaskModel")}
            disabled={saving || dictationPending || environmentUnavailable}
          />
        </SettingsSection>

        <SettingsSection title="Spațiu de lucru">
          <SelectRow
            label="Rulează în"
            value={
              draft.workspace === "worktree"
                ? "Worktree nou"
                : draft.workspace === "root"
                  ? "Checkout-ul proiectului"
                  : "Checkout specific"
            }
            actions={[
              {
                id: "worktree",
                title: "Worktree nou",
                state: draft.workspace === "worktree" ? "on" : undefined,
              },
              {
                id: "root",
                title: "Checkout-ul proiectului",
                state: draft.workspace === "root" ? "on" : undefined,
              },
              {
                id: "existing_worktree",
                title: "Checkout specific",
                state: draft.workspace === "existing_worktree" ? "on" : undefined,
              },
            ]}
            onSelect={(id) => {
              if (id === "worktree" || id === "root" || id === "existing_worktree")
                setDraft({ ...draft, workspace: id });
            }}
          />
          {draft.workspace === "worktree" ? (
            <PickerRow
              label="Branch de bază"
              value={resolveNewTaskBranchLabel({
                branchName: draft.baseRef,
                startFromOrigin: draft.startFromOrigin,
                workspaceMode: "worktree",
              })}
              borderTop
              disabled={!draft.projectId || saving || dictationPending || environmentUnavailable}
              onPress={() => navigation.navigate("SettingsScheduledTaskBranch")}
            />
          ) : null}
          {draft.workspace === "existing_worktree" ? (
            <FormField
              label="Calea checkout-ului"
              disabled={saving}
              value={draft.checkoutPath}
              borderTop
              onChange={(checkoutPath) => setDraft({ ...draft, checkoutPath })}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="Program">
          <View className="px-4 py-3">
            <SegmentedControl
              options={[
                { value: "fixed_time", label: "La o oră" },
                { value: "interval", label: "Interval" },
                { value: "webhook", label: "La webhook" },
              ]}
              selected={draft.schedule.mode}
              onSelect={(mode) => {
                setTimePickerOpen(false);
                setDraft({
                  ...draft,
                  prompt:
                    mode === "webhook" && !draft.prompt.trim()
                      ? DEFAULT_WEBHOOK_PROMPT
                      : draft.prompt,
                  schedule: { ...draft.schedule, mode },
                });
              }}
            />
          </View>
          {draft.schedule.mode === "fixed_time" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Ora, ${formatTime(draft.schedule.timeOfDay)}`}
                onPress={() => setTimePickerOpen((open) => !open)}
                className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
              >
                <Text className="text-lg text-foreground">Ora</Text>
                <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted">
                  {formatTime(draft.schedule.timeOfDay)}
                </Text>
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
              {timePickerOpen ? (
                <DateTimePicker
                  value={timePickerValue(draft.schedule.timeOfDay)}
                  mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  onDismiss={() => setTimePickerOpen(false)}
                  onValueChange={(_, selected) => {
                    const timeOfDay = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
                    setDraft({ ...draft, schedule: { ...draft.schedule, timeOfDay } });
                  }}
                />
              ) : null}
              <SelectRow
                label="Repetă"
                value={repeatLabel(draft.schedule.weekdays)}
                borderTop
                actions={[
                  {
                    id: "every_day",
                    title: "Zilnic",
                    state: draft.schedule.weekdays.length === 7 ? "on" : undefined,
                  },
                  {
                    id: "weekdays",
                    title: "În zilele lucrătoare",
                    state:
                      repeatLabel(draft.schedule.weekdays) === "În zilele lucrătoare"
                        ? "on"
                        : undefined,
                  },
                  ...DAYS.map((day) => ({
                    id: String(day.index),
                    title: day.label,
                    attributes: { keepsMenuPresented: true },
                    state: draft.schedule.weekdays.includes(day.index)
                      ? ("on" as const)
                      : undefined,
                  })),
                ]}
                onSelect={(id) => {
                  const weekdays =
                    id === "every_day"
                      ? DAYS.map((day) => day.index)
                      : id === "weekdays"
                        ? [1, 2, 3, 4, 5]
                        : (() => {
                            const day = DAYS.find((item) => String(item.index) === id);
                            if (!day) return draft.schedule.weekdays;
                            return draft.schedule.weekdays.includes(day.index)
                              ? draft.schedule.weekdays.filter((index) => index !== day.index)
                              : [...draft.schedule.weekdays, day.index];
                          })();
                  setDraft({ ...draft, schedule: { ...draft.schedule, weekdays } });
                }}
              />
            </>
          ) : draft.schedule.mode === "webhook" ? (
            <>
              <WebhookScheduleDetails
                environmentId={environmentId}
                // Use the live row for rotated URLs; hide the URL once a loaded list no longer contains the task.
                task={
                  tasks.data
                    ? (tasks.data.tasks.find((task) => task.id === draft.task?.id) ?? null)
                    : draft.task
                }
                signatureConfigured={draft.schedule.signature !== null}
                disabled={!canOperate || saving || environmentUnavailable}
              />
              <FormField
                label="Ignoră cererile mai vechi de (minute)"
                value={draft.schedule.maxDeliveryAgeMinutes}
                placeholder="Rulează orice cerere"
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(maxDeliveryAgeMinutes) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, maxDeliveryAgeMinutes } })
                }
              />
              <WebhookFilterRows
                filters={draft.schedule.filters}
                disabled={saving}
                onChange={(filters) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, filters } })
                }
              />
              <FormField
                label="Șablon cheie de repetare"
                value={draft.schedule.replayKey}
                placeholder="{{headers.delivery-id}}"
                disabled={saving}
                borderTop
                onChange={(replayKey) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, replayKey } })
                }
              />
              <FormField
                label="Șablon cheie de comasare"
                value={draft.schedule.coalesceKey}
                placeholder="{{body.id}}"
                disabled={saving}
                borderTop
                onChange={(coalesceKey) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, coalesceKey } })
                }
              />
              <FormField
                label="Fereastră de comasare (secunde, 10–3600)"
                value={draft.schedule.coalesceWindowSeconds}
                placeholder="120"
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(coalesceWindowSeconds) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, coalesceWindowSeconds } })
                }
              />
              <Text className="px-4 pb-3 text-sm text-foreground-muted">
                Cheile de repetare blochează duplicatele timp de 7 zile. Comasarea rulează ultimul
                payload când se închide fereastra de la prima livrare. Cheile goale rulează normal.
              </Text>
            </>
          ) : (
            <>
              <FormField
                label="Minute între rulări"
                value={draft.schedule.intervalMinutes}
                keyboardType="decimal-pad"
                disabled={saving}
                borderTop
                onChange={(intervalMinutes) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, intervalMinutes } })
                }
              />
              {Number(draft.schedule.intervalMinutes) < 1 ? (
                <Text className="px-4 pb-3 text-sm text-danger-foreground">
                  Intervalul trebuie să fie de cel puțin 1 minut. Modifică-l înainte să salvezi.
                </Text>
              ) : draft.task?.schedule.type === "interval" &&
                draft.task.schedule.everyMs < 60_000 ? (
                <Text className="px-4 pb-3 text-sm text-foreground-muted">
                  Această sarcină rula mai des de o dată pe minut. Pentru salvare e nevoie de un
                  interval de cel puțin 1 minut.
                </Text>
              ) : null}
            </>
          )}
          <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
            <Text className="min-w-0 flex-1 text-lg text-foreground">Activă</Text>
            <ThemedSwitch
              accessibilityLabel="Sarcină activă"
              value={draft.enabled}
              onValueChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </View>
        </SettingsSection>
        {draft.schedule.mode === "fixed_time" ? (
          <Text className="px-2 text-sm text-foreground-muted">
            Ora folosește fusul orar al mediului, care poate fi diferit de cel al telefonului.
          </Text>
        ) : null}
      </View>
      <Button
        tone="primary"
        fullWidth
        loading={saving}
        disabled={!canOperate || dictationPending || taskMissing || environmentUnavailable}
        onPress={() => void save()}
        label={saving ? "Se salvează…" : draft.task ? "Salvează modificările" : "Creează sarcina"}
      />
    </View>
  );
}

function WebhookScheduleDetails({
  environmentId,
  task,
  signatureConfigured,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly signatureConfigured: boolean;
  readonly disabled: boolean;
}) {
  const [rotating, setRotating] = useState(false);
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const webhook = task?.schedule.type === "webhook" ? task.webhook : undefined;
  const resolved = webhook ? webhookAddress(webhook, httpBaseUrl) : null;
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        {
          "Promptul poate folosi {{body.a.b}}, {{headers.name}}, {{query.name}}, {{body}} și {{request}}. Agentul vede doar promptul completat."
        }
      </Text>
      {task === null || resolved === null ? (
        <Text className="text-sm text-foreground-muted">
          Salvează sarcina ca să primești adresa webhook.
        </Text>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copiază adresa webhook"
            accessibilityHint="Copiază adresa în clipboard"
            disabled={!resolved.copyable}
            onPress={() => void tryCopyTextWithHaptic(resolved.address)}
            className="gap-1 active:opacity-70"
          >
            <Text className="text-lg text-foreground">
              {resolved.copyable ? "Adresă webhook" : "Cale webhook"}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={2} selectable>
              {resolved.address}
            </Text>
          </Pressable>
          {resolved.note !== null ? (
            <Text className="text-sm text-foreground-muted">{resolved.note}</Text>
          ) : null}
          <Button
            label={rotating ? "Se schimbă…" : "Schimbă adresa"}
            tone="danger"
            disabled={disabled || rotating}
            onPress={() =>
              Dialog.alert("Schimbi adresa?", "Adresa curentă nu va mai funcționa imediat.", [
                { text: "Anulează", style: "cancel" },
                {
                  text: "Schimbă",
                  style: "destructive",
                  onPress: () => {
                    setRotating(true);
                    void rotate({ environmentId, input: { id: task.id } }).then((result) => {
                      setRotating(false);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        Dialog.alert(
                          "Adresa nu a putut fi schimbată",
                          String(squashAtomCommandFailure(result)),
                        );
                      }
                    });
                  },
                },
              ])
            }
            loading={rotating}
          />
        </>
      )}
      {signatureConfigured ? (
        <Text className="text-sm text-foreground-muted">
          Verificarea semnăturii e configurată pe desktop/web.
        </Text>
      ) : null}
    </View>
  );
}

function EnvironmentTasks({
  environment,
  now,
  projectIds,
  onEdit,
}: {
  readonly environment: SettingsTarget;
  readonly now: number;
  readonly projectIds: readonly ProjectId[] | null;
  readonly onEdit: (task: ScheduledTask) => void;
}) {
  const environmentId = environment.environmentId;
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const visibleTasks = tasks.data?.tasks.filter(
    (task) => projectIds === null || projectIds.includes(task.projectId),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
    reportFailure: false,
  });
  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const act = async (task: ScheduledTask, action: "run" | "toggle" | "delete") => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result =
      action === "run"
        ? await runNow({ environmentId, input: { id: task.id } })
        : action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await remove({ environmentId, input: { id: task.id } });
    failure(
      `Sarcina nu a putut fi ${action === "toggle" ? "actualizată" : action === "run" ? "rulată" : action === "delete" ? "ștearsă" : "modificată"}`,
      result,
    );
  };

  return (
    <SettingsSection
      title={environment.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
      }
    >
      {tasks.error ? (
        <Text className="p-4 text-base text-danger-foreground">{tasks.error}</Text>
      ) : !tasks.data ? (
        <Text className="p-4 text-base text-foreground-muted">Se încarcă sarcinile…</Text>
      ) : visibleTasks?.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {projectIds === null
            ? "Nicio sarcină programată încă."
            : "Nicio sarcină în acest proiect."}
        </Text>
      ) : (
        visibleTasks?.map((task, index) => (
          <View
            key={task.id}
            className={
              index === 0
                ? "flex-row items-start gap-1 px-4 py-4"
                : "flex-row items-start gap-1 border-t border-border-subtle px-4 py-4"
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Editează ${task.title}`}
              onPress={() => {
                onEdit(task);
              }}
              className="min-w-0 flex-1 gap-1 active:opacity-70"
            >
              <Text className="text-lg font-t3-medium text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {describeSchedule(task)}
                {!task.enabled
                  ? " · Pusă pe pauză"
                  : task.nextRunAt
                    ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                    : ""}
              </Text>
              {task.lastRunError ? (
                <Text className="text-sm text-danger-foreground" numberOfLines={2}>
                  Last run failed: {task.lastRunError}
                </Text>
              ) : null}
            </Pressable>
            <Menu
              actions={[
                { id: "edit", title: "Editează" },
                {
                  id: "toggle",
                  title: task.enabled ? "Pauză" : "Reia",
                  attributes: { disabled: !canOperate },
                },
                ...(task.schedule.type === "webhook"
                  ? []
                  : [{ id: "run", title: "Rulează acum", attributes: { disabled: !canOperate } }]),
                {
                  id: "delete",
                  title: "Șterge",
                  attributes: { destructive: true, disabled: !canOperate },
                },
              ]}
              onPressAction={({ nativeEvent }) => {
                const action = nativeEvent.event;
                if (action === "edit") {
                  onEdit(task);
                } else if (action === "delete") {
                  Dialog.alert("Ștergi sarcina?", task.title, [
                    { text: "Anulează", style: "cancel" },
                    {
                      text: "Șterge",
                      style: "destructive",
                      onPress: () => void act(task, "delete"),
                    },
                  ]);
                } else if (action === "toggle" || action === "run") {
                  void act(task, action);
                }
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Acțiuni pentru ${task.title}`}
                className="h-11 w-11 items-center justify-center"
              >
                <SymbolView
                  name="ellipsis"
                  size={18}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </Pressable>
            </Menu>
          </View>
        ))
      )}
    </SettingsSection>
  );
}
