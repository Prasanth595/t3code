import { useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  useWindowDimensions,
  View,
  type TextInputInstance,
} from "react-native";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { AppText, AppTextInput } from "./AppText";
import { Button } from "./Button";
import { GlassSurface } from "./GlassSurface";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

/** Informational and multi-action alerts share the same platform presenter. */
export function alert(...args: Parameters<typeof Alert.alert>): void {
  Alert.alert(...args);
}

export function confirm(request: ConfirmDialogRequest): void {
  Alert.alert(request.title, request.message, [
    { text: request.cancelText ?? "Cancel", style: "cancel", onPress: request.onCancel },
    {
      text: request.confirmText,
      style: request.destructive ? "destructive" : "default",
      onPress: request.onConfirm,
    },
  ]);
}

// The most recently mounted host presents, so a sheet's host wins while the sheet is open.
const promptPresenters: Array<(request: TextInputDialogRequest) => void> = [];

// UIAlertController's text field lays out past the alert's edge on iOS 26 (Liquid Glass),
// so prompts render in-app instead of through Alert.prompt.
export function prompt(request: TextInputDialogRequest): void {
  promptPresenters.at(-1)?.(request);
}

/** iOS presenter for Dialog.prompt; alerts and confirms are presented directly by React Native. */
export function Host() {
  const [presented, setPresented] = useState<
    (TextInputDialogRequest & { readonly id: number }) | null
  >(null);
  const nextPresentationId = useRef(0);
  useEffect(() => {
    const present = (request: TextInputDialogRequest) =>
      setPresented({ ...request, id: ++nextPresentationId.current });
    promptPresenters.push(present);
    return () => {
      promptPresenters.splice(promptPresenters.indexOf(present), 1);
    };
  }, []);

  return presented ? (
    <PromptDialog key={presented.id} request={presented} onClose={() => setPresented(null)} />
  ) : null;
}

/**
 * A React Native Modal presents from its nearest view controller, and the root one cannot present
 * over a native sheet. Mount this inside sheets that open prompts.
 */
export const SheetHost = Host;

function PromptDialog(props: {
  readonly request: TextInputDialogRequest;
  readonly onClose: () => void;
}) {
  const { request } = props;
  const { width, height, fontScale } = useWindowDimensions();
  const stackActions = fontScale > 1.3;
  const { themeVariables } = useAppearancePreferences();
  const inputRef = useRef<TextInputInstance>(null);
  const settled = useRef(false);
  const [value, setValue] = useState(request.initialValue);
  // A second tap can land before the modal unmounts; only the first one counts.
  const settle = (run: () => void) => {
    if (settled.current) return;
    settled.current = true;
    props.onClose();
    run();
  };
  const cancel = () => settle(() => request.onCancel?.());
  const submit = () => settle(() => request.onConfirm(value));

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onShow={() => inputRef.current?.focus()}
      onRequestClose={cancel}
    >
      <KeyboardAvoidingView
        behavior="padding"
        className="flex-1 items-center justify-center bg-backdrop p-6"
      >
        <GlassSurface
          accessibilityViewIsModal
          className="bg-sheet"
          tintColorClassName="accent-sheet/20"
          fallbackColor={themeVariables["--color-sheet"]}
          style={{ width: Math.min(340, width - 48), maxHeight: height - 96, borderRadius: 28 }}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-4 p-5"
            alwaysBounceVertical={false}
          >
            <AppText accessibilityRole="header" textRole="title" className="text-center">
              {request.title}
            </AppText>
            {request.message ? (
              <AppText textRole="footnote" className="text-center text-foreground-muted">
                {request.message}
              </AppText>
            ) : null}
            <AppTextInput
              ref={inputRef}
              accessibilityLabel={request.title}
              placeholder={request.placeholder}
              value={value}
              onChangeText={setValue}
              selectTextOnFocus
              clearButtonMode="while-editing"
              returnKeyType="done"
              submitBehavior="submit"
              onSubmitEditing={submit}
            />
            <View className={stackActions ? "flex-col-reverse gap-3" : "flex-row gap-3"}>
              <View className={stackActions ? undefined : "flex-1"}>
                <Button fullWidth label={request.cancelText ?? "Cancel"} onPress={cancel} />
              </View>
              <View className={stackActions ? undefined : "flex-1"}>
                <Button fullWidth tone="primary" label={request.confirmText} onPress={submit} />
              </View>
            </View>
          </ScrollView>
        </GlassSurface>
      </KeyboardAvoidingView>
    </Modal>
  );
}
