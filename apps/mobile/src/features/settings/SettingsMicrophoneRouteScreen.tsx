import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Pressable, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import {
  isMicrophoneDevice,
  type MicrophoneEntry,
  type MicrophoneKind,
  microphoneEntryKey,
  microphoneOrder,
} from "../../lib/microphonePriority";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { SettingsSection } from "./components/SettingsSection";

const REMOVE_SIZE = 20;

type MicrophonePermission = "checking" | "granted" | "ask" | "denied";

function useMicrophonePermission() {
  const [permission, setPermission] = useState<MicrophonePermission>("checking");
  const apply = useCallback(
    (response: { readonly granted: boolean; readonly canAskAgain: boolean }) =>
      setPermission(response.granted ? "granted" : response.canAskAgain ? "ask" : "denied"),
    [],
  );
  const refresh = useCallback(
    () => void getRecordingPermissionsAsync().then(apply, () => setPermission("ask")),
    [apply],
  );
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  const request = useCallback(
    () => void requestRecordingPermissionsAsync().then(apply, refresh),
    [apply, refresh],
  );
  return { permission, request };
}

const KINDS: Record<
  MicrophoneKind,
  {
    readonly label: string;
    readonly row: string;
    readonly rowDescription: string;
    readonly icon: AppSymbolName;
  }
> = {
  wired: {
    label: "Cu fir",
    row: "Alte dispozitive cu fir",
    rowDescription: "Căști și microfoane USB nelistate",
    icon: "cable.connector",
  },
  bluetooth: {
    label: "Bluetooth",
    row: "Alte dispozitive Bluetooth",
    rowDescription: "AirPods, căști și mașini nelistate",
    icon: "headphones",
  },
  builtIn: {
    label: "Integrat",
    row: "Microfon integrat",
    rowDescription: "Microfonul acestui dispozitiv",
    icon: "iphone",
  },
  carPlay: {
    label: "CarPlay",
    row: "CarPlay",
    rowDescription: "Microfonul mașinii",
    icon: "car",
  },
};

export function SettingsMicrophoneRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const entries = microphoneOrder(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value.microphones : undefined,
  );
  const hasDevices = entries.some(isMicrophoneDevice);
  const { permission, request: requestPermission } = useMicrophonePermission();
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<{ readonly key: string; readonly translation: number } | null>(
    null,
  );
  const [rowHeight, setRowHeight] = useState(0);
  // Each drop remounts the rows so the new order and the cleared offsets land in one frame.
  const [drops, setDrops] = useState(0);

  // Transforms apply to the stored order, so a device recorded meanwhile is kept.
  const move = (key: string, steps: number) =>
    savePreferences({
      transform: (current) => {
        const next = [...microphoneOrder(current.microphones)];
        const from = next.findIndex((entry) => microphoneEntryKey(entry) === key);
        const to = Math.min(next.length - 1, Math.max(0, from + steps));
        if (from === -1 || from === to) return {};
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return { microphones: next };
      },
    });
  const forget = (key: string) =>
    savePreferences({
      transform: (current) => ({
        microphones: microphoneOrder(current.microphones).filter(
          (entry) => microphoneEntryKey(entry) !== key,
        ),
      }),
    });
  const dropSteps = (from: number, translation: number) =>
    rowHeight === 0
      ? 0
      : Math.min(entries.length - 1, Math.max(0, from + Math.round(translation / rowHeight))) -
        from;

  const dragFrom =
    drag === null ? -1 : entries.findIndex((entry) => microphoneEntryKey(entry) === drag.key);
  const dragTo = drag === null ? -1 : dragFrom + dropSteps(dragFrom, drag.translation);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {permission === "ask" || permission === "denied" ? (
          <>
            <SettingsSection title="Acces la microfon">
              <SettingsActionRow
                icon="mic"
                label={permission === "ask" ? "Permite accesul la microfon" : "Deschide Setările"}
                onPress={
                  permission === "ask" ? requestPermission : () => void Linking.openSettings()
                }
              />
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              {permission === "ask"
                ? "Dictarea are nevoie de acces la microfon ca să înregistreze sau să-ți listeze microfoanele."
                : "Accesul la microfon e oprit pentru Mira. Activează-l din Setări ca să folosești dictarea."}
            </Text>
          </>
        ) : null}
        <SettingsSection
          title="Ordinea preferată"
          trailing={
            hasDevices ? (
              <Button
                label={editing ? "Gata" : "Editează"}
                tone="text"
                onPress={() => setEditing((value) => !value)}
              />
            ) : undefined
          }
        >
          {entries.map((entry, index) => {
            const key = microphoneEntryKey(entry);
            const shift =
              dragFrom === -1 || index === dragFrom
                ? 0
                : dragFrom < dragTo && index > dragFrom && index <= dragTo
                  ? -rowHeight
                  : dragFrom > dragTo && index < dragFrom && index >= dragTo
                    ? rowHeight
                    : 0;
            return (
              <MicrophoneRow
                key={`${key}:${drops}`}
                entry={entry}
                position={index + 1}
                count={entries.length}
                reorderable={ready}
                editing={editing && hasDevices}
                offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
                lifted={index === dragFrom}
                onHeight={setRowHeight}
                onDragStart={() => setDrag({ key, translation: 0 })}
                onDragMove={(translation) => setDrag({ key, translation })}
                onDragEnd={(translation, cancelled) => {
                  setDrag(null);
                  setDrops((count) => count + 1);
                  if (!cancelled) move(key, dropSteps(index, translation));
                }}
                onStep={(direction) => move(key, direction === "up" ? -1 : 1)}
                onForget={isMicrophoneDevice(entry) ? () => forget(key) : undefined}
              />
            );
          })}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Dictarea înregistrează de la primul microfon conectat din listă. Dispozitivele cu fir și
          Bluetooth sunt adăugate după nume după ce folosești dictarea cu ele conectate; până
          atunci, rândul Alte le ordonează.
        </Text>
      </ScrollView>
    </View>
  );
}

function MicrophoneRow(props: {
  readonly entry: MicrophoneEntry;
  readonly position: number;
  readonly count: number;
  readonly reorderable: boolean;
  readonly editing: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
  readonly onForget: (() => void) | undefined;
}) {
  const { lifted, offset, entry } = props;
  const kind = KINDS[entry.kind];
  const title = isMicrophoneDevice(entry) ? entry.name : kind.row;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: lifted
          ? offset
          : withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System }),
      },
    ],
    zIndex: lifted ? 1 : 0,
  }));
  return (
    <Reanimated.View
      style={style}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
      className={cn(
        "flex-row items-center gap-4 pl-4",
        props.position > 1 && !lifted && "border-t border-border-subtle",
        lifted && "bg-grouped-card shadow-md",
        !props.reorderable && "pr-4",
      )}
    >
      {props.editing && props.onForget ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Uită ${title}`}
          hitSlop={8}
          onPress={props.onForget}
          className="active:opacity-70"
        >
          <SymbolView
            name="xmark.circle.fill"
            size={REMOVE_SIZE}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : props.editing ? (
        <View style={{ width: REMOVE_SIZE }} />
      ) : null}
      <View
        accessible
        accessibilityLabel={`${title}, ${kind.label}, ${props.position} of ${props.count}`}
        className="min-w-0 flex-1 flex-row items-center gap-4 py-4"
      >
        <SymbolView
          name={kind.icon}
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-lg text-foreground">
            {title}
          </Text>
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {isMicrophoneDevice(entry) ? kind.label : kind.rowDescription}
          </Text>
        </View>
      </View>
      {props.reorderable ? (
        <SettingsDragHandle
          title={title}
          canMoveUp={props.position > 1}
          canMoveDown={props.position < props.count}
          onStart={props.onDragStart}
          onMove={props.onDragMove}
          onEnd={props.onDragEnd}
          onStep={props.onStep}
        />
      ) : null}
    </Reanimated.View>
  );
}
