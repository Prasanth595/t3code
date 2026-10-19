import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AndroidScreenHeader } from "./AndroidScreenHeader";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Toolbar } from "./Toolbar";
import { useControlTheme } from "./useControlTheme";

type SheetDismissAction =
  | { readonly onCancel: () => void; readonly onClose?: never }
  | { readonly onClose: () => void; readonly onCancel?: never };

type SheetConfirmation = {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
};

type SheetHeaderProps = SheetDismissAction & {
  readonly title: string;
  readonly subtitle?: string;
  readonly accessibilityLabel?: string;
  readonly dismissDisabled?: boolean;
  readonly confirm?: SheetConfirmation;
  readonly presentation?: "native" | "inline";
  readonly trailing?: ReactNode;
};

export function SheetCloseButton(
  props: SheetDismissAction & {
    readonly accessibilityLabel?: string;
    readonly disabled?: boolean;
  },
) {
  return (
    <IconButton
      icon="xmark"
      accessibilityLabel={props.accessibilityLabel ?? (props.onCancel ? "Cancel" : "Close")}
      disabled={props.disabled}
      tintColorClassName={Platform.OS === "android" ? "accent-header-foreground" : undefined}
      onPress={props.onCancel ?? props.onClose}
    />
  );
}

export function SheetHeader(props: SheetHeaderProps) {
  return Platform.OS === "ios" && props.presentation !== "inline" ? (
    <NativeSheetHeader {...props} />
  ) : (
    <InlineSheetHeader {...props} />
  );
}

function NativeSheetHeader(props: SheetHeaderProps) {
  const { colors } = useControlTheme();
  const onDismiss = props.onCancel ?? props.onClose;
  const dismissLabel = props.accessibilityLabel ?? (props.onCancel ? "Cancel" : "Close");
  const confirmation = props.confirm;

  // Toolbar children are parsed as native items, so keep the actual Button
  // elements here instead of hiding them behind another component.
  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: props.title,
          headerBackVisible: false,
          unstable_headerSubtitle: props.subtitle,
        }}
      />
      <Toolbar placement="left">
        <Toolbar.Button
          icon="xmark"
          accessibilityLabel={dismissLabel}
          onPress={onDismiss}
          disabled={props.dismissDisabled}
        />
      </Toolbar>
      {confirmation || props.trailing ? (
        <Toolbar placement="right">
          {props.trailing ? (
            <Toolbar.Custom>
              <View>{props.trailing}</View>
            </Toolbar.Custom>
          ) : null}
          {confirmation?.loading ? (
            <Toolbar.Custom>
              <View
                className="size-11 items-center justify-center"
                accessibilityLabel={confirmation.label}
                accessibilityState={{ busy: true }}
              >
                <AppActivityIndicator colorClassName="accent-prominent-action" />
              </View>
            </Toolbar.Custom>
          ) : confirmation ? (
            <Toolbar.Button
              icon="checkmark"
              variant="prominent"
              tintColor={colors["--color-prominent-action"]}
              accessibilityLabel={confirmation.label}
              disabled={confirmation.disabled}
              onPress={confirmation.onPress}
            />
          ) : null}
        </Toolbar>
      ) : null}
    </>
  );
}

function InlineConfirmation({ confirmation }: { readonly confirmation: SheetConfirmation }) {
  const confirmDisabled = confirmation.disabled || confirmation.loading;
  return Platform.OS === "android" ? (
    <Button
      label={confirmation.label}
      tone="text"
      loading={confirmation.loading}
      disabled={confirmation.disabled}
      onPress={confirmation.onPress}
    />
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={confirmation.label}
      accessibilityState={{
        disabled: Boolean(confirmDisabled),
        busy: Boolean(confirmation.loading),
      }}
      disabled={confirmDisabled}
      onPress={confirmation.onPress}
      className={
        confirmDisabled
          ? "size-11 items-center justify-center rounded-full bg-subtle-strong"
          : "size-11 items-center justify-center rounded-full bg-prominent-action"
      }
    >
      {confirmation.loading ? (
        <AppActivityIndicator colorClassName="accent-icon-subtle" />
      ) : (
        <SymbolView
          name="checkmark"
          size={20}
          tintColorClassName={
            confirmDisabled ? "accent-icon-subtle" : "accent-prominent-action-foreground"
          }
        />
      )}
    </Pressable>
  );
}

function InlineSheetHeader(props: SheetHeaderProps) {
  const close = (
    <SheetCloseButton
      {...(props.onCancel ? { onCancel: props.onCancel } : { onClose: props.onClose })}
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.dismissDisabled}
    />
  );
  const confirm = props.confirm ? <InlineConfirmation confirmation={props.confirm} /> : null;
  const trailing =
    props.trailing || confirm ? (
      <View className="flex-row items-center gap-2">
        {props.trailing}
        {confirm}
      </View>
    ) : undefined;

  if (Platform.OS === "android") {
    return (
      <AndroidScreenHeader
        embedded={props.presentation === "inline"}
        title={props.title}
        subtitle={props.subtitle}
        leading={close}
        trailing={trailing}
        hideBottomBorder
      />
    );
  }
  return (
    <View className="flex-row items-center gap-3 px-4 pt-3 pb-3">
      {close}
      <View className="min-w-0 flex-1 gap-1">
        <AppText numberOfLines={1} className="text-base font-t3-bold text-foreground">
          {props.title}
        </AppText>
        {props.subtitle ? (
          <AppText
            numberOfLines={1}
            ellipsizeMode="middle"
            className="text-xs text-foreground-muted"
          >
            {props.subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}
