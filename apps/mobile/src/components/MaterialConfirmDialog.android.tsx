import {
  AlertDialog,
  Host,
  OutlinedTextField,
  Row,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import { Fragment, useState } from "react";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { MaterialConfirmDialogProps, MaterialDialogButton } from "./MaterialConfirmDialog";

export function MaterialConfirmDialog(props: MaterialConfirmDialogProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const inputTypography = useScaledTextRole("body");
  const hasInput = props.inputInitialValue !== undefined;
  const inputState = useNativeState(props.inputInitialValue ?? "");
  const inputSelection = useNativeState({ start: 0, end: props.inputInitialValue?.length ?? 0 });
  const [inputBlank, setInputBlank] = useState(hasInput && !props.inputInitialValue?.trim());
  const confirmButton = props.buttons[props.buttons.length - 1];
  const otherButtons = props.buttons.slice(0, -1);
  const confirm = () => {
    const value = inputState.get();
    if (confirmButton === undefined || (hasInput && !value.trim())) return;
    confirmButton.onPress(value);
  };
  const renderButton = (button: MaterialDialogButton, onClick: () => void, enabled = true) => (
    <TextButton
      onClick={onClick}
      enabled={enabled}
      colors={{
        contentColor:
          colors[button.destructive ? "--color-danger-foreground" : "--color-primary-text"],
      }}
    >
      <Text style={bodyTypography}>{button.text}</Text>
    </TextButton>
  );
  return (
    <Host
      colorScheme={themeAppearance}
      ignoreSafeAreaKeyboardInsets
      style={{ height: 0, width: 0 }}
    >
      <AlertDialog
        onDismissRequest={props.onDismiss}
        tonalElevation={0}
        colors={{
          containerColor: colors["--color-card-alt"],
          titleContentColor: colors["--color-foreground"],
          textContentColor: colors["--color-foreground-secondary"],
        }}
      >
        <AlertDialog.Title>
          <Text style={titleTypography}>{props.title}</Text>
        </AlertDialog.Title>
        {hasInput ? (
          <AlertDialog.Text>
            <OutlinedTextField
              autoFocus
              singleLine
              value={inputState}
              selection={inputSelection}
              onValueChange={(value) => setInputBlank(!value.trim())}
              textStyle={inputTypography}
              keyboardOptions={{ imeAction: "done" }}
              keyboardActions={{
                onDone: confirm,
              }}
              colors={{
                focusedTextColor: colors["--color-foreground"],
                unfocusedTextColor: colors["--color-foreground"],
                focusedIndicatorColor: colors["--color-focus"],
                unfocusedIndicatorColor: colors["--color-border"],
                cursorColor: colors["--color-focus"],
              }}
            >
              <OutlinedTextField.Label>
                <Text style={bodyTypography}>{props.title}</Text>
              </OutlinedTextField.Label>
            </OutlinedTextField>
          </AlertDialog.Text>
        ) : props.message ? (
          <AlertDialog.Text>
            <Text style={bodyTypography}>{props.message}</Text>
          </AlertDialog.Text>
        ) : null}
        {otherButtons.length > 0 ? (
          <AlertDialog.DismissButton>
            <Row>
              {otherButtons.map((button) => (
                <Fragment key={button.text}>
                  {renderButton(button, () => button.onPress(inputState.get()))}
                </Fragment>
              ))}
            </Row>
          </AlertDialog.DismissButton>
        ) : null}
        {confirmButton !== undefined ? (
          <AlertDialog.ConfirmButton>
            {renderButton(confirmButton, confirm, !inputBlank)}
          </AlertDialog.ConfirmButton>
        ) : null}
      </AlertDialog>
    </Host>
  );
}
