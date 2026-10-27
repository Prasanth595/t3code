import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { useSystemFontScale } from "../../lib/useSystemFontScale";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SheetHeader } from "../../components/ui/SheetHeader";
import {
  DatePicker,
  Host,
  HStack,
  Picker,
  Popover,
  RNHostView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  clipped,
  font,
  datePickerStyle,
  foregroundStyle,
  frame,
  labelsHidden,
  padding,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { useState, type ReactNode } from "react";
import { NavigationContainer, NavigationIndependentTree } from "@react-navigation/native";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const durationAmounts = Array.from({ length: 99 }, (_, index) => index + 1);
const SnoozeStack = createNativeStackNavigator<{ CustomSnooze: undefined }>();
const modes = [
  { value: "date", label: "Date and time" },
  { value: "duration", label: "Duration" },
] as const;
const units = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

export function CustomSnoozeSheet(props: {
  readonly onClose: () => void;
  readonly onSnooze: (snoozedUntil: string) => void;
}) {
  const { width, height } = useWindowDimensions();
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(() => new Date(Date.now() + 3_600_000));
  const [amount, setAmount] = useState(2);
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const { themeVariables: colors, themeAppearance } = useAppearancePreferences();
  const bodyTypography = useScaledTextRole("body");
  const footnoteTypography = useScaledTextRole("footnote");
  const scaleSystemFont = useSystemFontScale();
  const popoverWidth = Math.min(360, width - 32);
  const popoverHeight = Math.min(
    324 +
      Math.max(0, scaleSystemFont(bodyTypography.lineHeight) - 23) * 2 +
      (error ? scaleSystemFont(footnoteTypography.lineHeight) * 2 + 12 : 0),
    height - 96,
  );
  const updateDate = (value: Date) => {
    setDate(value);
    setError(null);
  };

  const submit = () => {
    const input: CustomSnoozeInput =
      mode === "date"
        ? { mode, date: localSnoozeDate(date), time: localSnoozeTime(date) }
        : { mode, amount: String(amount), unit };
    const snoozedUntil = resolveCustomSnooze(input, new Date());
    if (!snoozedUntil) {
      setError(
        mode === "date" ? "Choose a date and time in the future." : "Enter a positive duration.",
      );
      return;
    }
    props.onSnooze(snoozedUntil);
    props.onClose();
  };

  return (
    <Host
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      colorScheme={themeAppearance}
      seedColor={colors["--color-primary"]}
    >
      <Popover
        isPresented
        onIsPresentedChange={(presented) => {
          if (!presented) props.onClose();
        }}
      >
        <Popover.Trigger>
          <Spacer
            modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity }), accessibilityHidden()]}
          />
        </Popover.Trigger>
        <Popover.Content>
          <SnoozePopoverNavigation
            width={popoverWidth}
            height={popoverHeight}
            onClose={props.onClose}
            onSubmit={submit}
          >
            <Host
              matchContents={{ vertical: true }}
              colorScheme={themeAppearance}
              style={{ width: popoverWidth }}
            >
              <VStack
                spacing={16}
                modifiers={[padding({ all: 16 }), foregroundStyle(colors["--color-foreground"])]}
              >
                <RNHostView matchContents={{ vertical: true }}>
                  <View style={{ width: popoverWidth - 32 }}>
                    <SegmentedControl
                      options={modes}
                      selected={mode}
                      onSelect={(value) => {
                        setMode(value);
                        setError(null);
                      }}
                      size="compact"
                    />
                  </View>
                </RNHostView>
                {mode === "date" ? (
                  <DatePicker
                    title="Snooze until"
                    selection={date}
                    displayedComponents={["date", "hourAndMinute"]}
                    onDateChange={updateDate}
                    modifiers={[
                      datePickerStyle("wheel"),
                      labelsHidden(),
                      frame({ maxWidth: Infinity, minHeight: 180, maxHeight: 180 }),
                    ]}
                  />
                ) : (
                  <HStack spacing={0}>
                    <Picker
                      label="Duration amount"
                      selection={amount}
                      onSelectionChange={(value: number) => {
                        setAmount(value);
                        setError(null);
                      }}
                      modifiers={[
                        pickerStyle("wheel"),
                        labelsHidden(),
                        frame({ minWidth: 0, maxWidth: Infinity, minHeight: 180, maxHeight: 180 }),
                        clipped(),
                      ]}
                    >
                      {durationAmounts.map((value) => (
                        <Text
                          key={value}
                          modifiers={[
                            tag(value),
                            font({ family: FONT_FAMILIES.regular, size: bodyTypography.fontSize }),
                            foregroundStyle(colors["--color-foreground"]),
                          ]}
                        >
                          {String(value)}
                        </Text>
                      ))}
                    </Picker>
                    <Picker
                      label="Duration unit"
                      selection={unit}
                      onSelectionChange={(value: typeof unit) => {
                        setUnit(value);
                        setError(null);
                      }}
                      modifiers={[
                        pickerStyle("wheel"),
                        labelsHidden(),
                        frame({ minWidth: 0, maxWidth: Infinity, minHeight: 180, maxHeight: 180 }),
                        clipped(),
                      ]}
                    >
                      {units.map((option) => (
                        <Text
                          key={option.value}
                          modifiers={[
                            tag(option.value),
                            font({ family: FONT_FAMILIES.regular, size: bodyTypography.fontSize }),
                            foregroundStyle(colors["--color-foreground"]),
                          ]}
                        >
                          {option.label}
                        </Text>
                      ))}
                    </Picker>
                  </HStack>
                )}
                {error ? (
                  <Text
                    modifiers={[
                      font({ family: FONT_FAMILIES.regular, size: footnoteTypography.fontSize }),
                      foregroundStyle(colors["--color-danger-foreground"]),
                    ]}
                  >
                    {error}
                  </Text>
                ) : null}
              </VStack>
            </Host>
          </SnoozePopoverNavigation>
        </Popover.Content>
      </Popover>
    </Host>
  );
}

function SnoozePopoverNavigation(props: {
  readonly width: number;
  readonly height: number;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  const navigationTheme = useMobileNavigationTheme();
  const { themeVariables: colors } = useAppearancePreferences();

  return (
    <VStack modifiers={[frame({ width: props.width, height: props.height })]}>
      <RNHostView>
        <View style={{ width: props.width, height: props.height }}>
          <NavigationIndependentTree>
            <NavigationContainer theme={navigationTheme}>
              <SnoozeStack.Navigator
                screenOptions={{
                  contentStyle: { backgroundColor: "transparent" },
                  headerShadowVisible: false,
                  headerStyle: {
                    backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED
                      ? "transparent"
                      : colors["--color-card"],
                  },
                  headerTintColor: colors["--color-foreground"],
                  headerTitleStyle: { fontSize: 17, fontWeight: "700" },
                  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
                  title: "Custom snooze",
                }}
              >
                <SnoozeStack.Screen name="CustomSnooze">
                  {() => (
                    <>
                      <SheetHeader
                        title="Custom snooze"
                        onCancel={props.onClose}
                        accessibilityLabel="Cancel custom snooze"
                        confirm={{ label: "Snooze", onPress: props.onSubmit }}
                      />
                      <ScrollView
                        contentInsetAdjustmentBehavior="automatic"
                        showsVerticalScrollIndicator={false}
                      >
                        {props.children}
                      </ScrollView>
                    </>
                  )}
                </SnoozeStack.Screen>
              </SnoozeStack.Navigator>
            </NavigationContainer>
          </NavigationIndependentTree>
        </View>
      </RNHostView>
    </VStack>
  );
}
