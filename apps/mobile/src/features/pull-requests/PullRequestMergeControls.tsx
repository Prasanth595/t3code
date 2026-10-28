import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeUnavailableReason,
  MERGE_CONFLICT_REASON,
  MERGE_METHODS,
  pullRequestActionLabel,
} from "./pullRequestActions";
import { pullRequestStackMerge, singlePullRequestMergeAllowed } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import type { PullRequestStackState } from "./usePullRequestStack";
import { PullRequestGlyph } from "./pullRequestGlyphs";

export function PullRequestMergeControls(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const { pr, stack } = props;
  const terminology = sourceControlClients.get(pr.provider).changeRequest;
  const target = pullRequestTarget(props.params);
  const permissions = usePullRequestPermissions(props.params, pr);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const [selectedMethod, setSelectedMethod] = useState<PullRequestMergeMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const methods = allowedMergeMethods(pr);
  const preferred =
    selectedMethod ??
    (AsyncResult.isSuccess(preferences) ? preferences.value.pullRequestMergeMethod : undefined) ??
    "squash";
  const method = methods.includes(preferred)
    ? preferred
    : methods.includes("squash")
      ? "squash"
      : methods[0];
  const scope = stack.stack ? pullRequestStackMerge(stack.stack, pr.number, terminology) : null;
  const canMergeSingle = singlePullRequestMergeAllowed({
    supportsStackActions: stack.supportsStackActions,
    hasStack: stack.stack !== null,
    isFresh: stack.isFresh,
  });
  const checkingStack =
    permissions.connected && stack.supportsStackActions && !stack.isFresh && !stack.error;
  const reason =
    (!permissions.connected
      ? "Reconectează-te ca să faci merge."
      : mergeUnavailableReason(pr, permissions.canWrite, terminology)) ??
    (stack.stack
      ? !stack.supportsStackActions
        ? "Acest mediu poate afișa stack-uri, dar nu le poate îmbina."
        : !stack.isFresh
          ? "Reîmprospătează stack-ul înainte de merge."
          : scope?.reason
      : !canMergeSingle
        ? stack.error
          ? "Stack-ul nu a putut fi verificat. Reîmprospătează înainte de merge."
          : "Se verifică stack-ul…"
        : null);
  const canMerge = !busy && method !== undefined && !reason;
  const label = method
    ? scope && scope.layers.length > 1
      ? `${MERGE_METHODS[method].title} stack (${scope.layers.length})`
      : MERGE_METHODS[method].title
    : "Merge indisponibil";
  const autoAction = pr.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge";
  const canAutoMerge =
    !busy &&
    (autoAction === "disable-auto-merge" || (!stack.stack && canMergeSingle)) &&
    permissions.canWrite &&
    canPerformPullRequestAction(pr, autoAction);

  const perform = async (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    if (
      pending.current ||
      (action !== "disable-auto-merge" && !method) ||
      (action === "merge" ? !canMerge : !canAutoMerge)
    )
      return;
    pending.current = true;
    setBusy(true);
    const response = await runAction({
      ...target,
      input: {
        ...target.input,
        action,
        ...(action === "merge" && method && stack.stack && scope
          ? {
              stackNumber: stack.stack.number,
              expectedStackHeads: scope.heads,
              mergeMethod: method,
            }
          : action === "merge" && method
            ? {
                resolveMergeMethod: (fresh) => {
                  if (
                    !canPerformPullRequestAction(fresh, "merge") ||
                    !allowedMergeMethods(fresh).includes(method)
                  )
                    throw new Error(
                      `${terminology.singular} s-a schimbat. Reîmprospătează înainte de merge.`,
                    );
                  return method;
                },
              }
            : action === "enable-auto-merge" && method
              ? { mergeMethod: method }
              : {}),
      },
    });
    // A stack can partly merge before the provider reports a failure.
    refreshDetail();
    refreshActivity();
    stack.refresh();
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        "Acțiunea de merge nu a putut fi finalizată",
        cause instanceof Error ? cause.message : "Încearcă din nou.",
      );
    }
  };
  const confirm = (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    const title =
      action === "merge"
        ? scope && scope.layers.length > 1
          ? `Faci merge la ${scope.layers.length} straturi din stack?`
          : `${pullRequestActionLabel("merge", terminology)}?`
        : action === "enable-auto-merge"
          ? "Activezi auto-merge?"
          : "Dezactivezi auto-merge?";
    const message =
      action === "merge" && scope
        ? `Merge ${scope.layers.map((layer) => `#${layer.number}`).join(" → ")} în ${stack.stack?.base} folosind ${method}. Straturile de deasupra #${pr.number} rămân deschise.`
        : action === "enable-auto-merge"
          ? `Merge #${pr.number} folosind ${method} când cerințele sunt îndeplinite. Se poate întâmpla imediat.`
          : action === "disable-auto-merge"
            ? `Oprește furnizorul să facă automat merge la acest ${terminology.singular}.`
            : `Merge #${pr.number} în ${pr.baseBranch} folosind ${method}.`;
    Dialog.alert(title, message, [
      { text: "Anulează", style: "cancel" },
      {
        text: action === "merge" ? label : title.replace("?", ""),
        onPress: () => void perform(action),
      },
    ]);
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <View
        className={
          Platform.OS === "android"
            ? "flex-row items-center gap-2"
            : `flex-row overflow-hidden rounded-xl border-continuous ${canMerge ? "bg-prominent-action" : "bg-subtle-strong"}`
        }
      >
        {Platform.OS === "android" ? (
          <View className="min-w-0 flex-1">
            <Button
              label={
                busy
                  ? "Se lucrează…"
                  : !permissions.connected
                    ? "Reconectează-te pentru merge"
                    : label
              }
              tone="primary"
              fullWidth
              disabled={!canMerge}
              loading={busy || checkingStack}
              onPress={() => confirm("merge")}
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              scope ? `${label}, ${scope.layers.length} straturi până la #${pr.number}` : label
            }
            accessibilityState={{ disabled: !canMerge, busy: busy || checkingStack }}
            disabled={!canMerge}
            onPress={() => confirm("merge")}
            className="min-h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 px-3 py-2 active:opacity-70"
          >
            {busy || checkingStack ? (
              <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
            ) : (
              <SymbolView
                name={PullRequestGlyph.merged}
                size={16}
                tintColorClassName={
                  canMerge ? "accent-prominent-action-foreground" : "accent-icon-muted"
                }
              />
            )}
            <Text
              className={`shrink text-center text-sm font-t3-semibold ${canMerge ? "text-prominent-action-foreground" : "text-foreground-muted"}`}
            >
              {busy
                ? "Se lucrează…"
                : !permissions.connected
                  ? "Reconectează-te pentru merge"
                  : label}
            </Text>
          </Pressable>
        )}
        {methods.length > 0 || canAutoMerge ? (
          <Menu
            title="Opțiuni merge"
            actions={[
              ...methods.map((id) => ({
                id,
                title: MERGE_METHODS[id].title,
                state: id === method ? ("on" as const) : ("off" as const),
                attributes: { disabled: busy },
              })),
              ...(canAutoMerge
                ? [
                    {
                      id: autoAction,
                      title: pr.autoMergeEnabled
                        ? "Dezactivează auto-merge"
                        : "Activează auto-merge",
                      image: "clock",
                    },
                  ]
                : []),
            ]}
            onPressAction={({ nativeEvent }) => {
              const selected = methods.find((id) => id === nativeEvent.event);
              if (selected) {
                setSelectedMethod(selected);
                savePreferences({ pullRequestMergeMethod: selected });
              } else if (nativeEvent.event === autoAction && canAutoMerge) confirm(autoAction);
            }}
          >
            {Platform.OS === "android" ? (
              <View pointerEvents="none">
                <IconButton
                  accessibilityLabel="Opțiuni merge"
                  icon="chevron.down"
                  variant="tonal"
                />
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Opțiuni merge"
                className="min-h-11 w-11 items-center justify-center border-l border-border-subtle"
              >
                <SymbolView
                  name="chevron.down"
                  size={13}
                  tintColorClassName={
                    canMerge ? "accent-prominent-action-foreground" : "accent-icon-muted"
                  }
                />
              </Pressable>
            )}
          </Menu>
        ) : null}
      </View>
      {permissions.connected &&
      reason &&
      reason !== MERGE_CONFLICT_REASON &&
      reason !== "Checking stack membership…" &&
      !(checkingStack && reason === "Reîmprospătează stack-ul înainte de merge.") ? (
        <Text className="px-1 text-xs text-foreground-muted">{reason}</Text>
      ) : null}
      {pr.autoMergeEnabled ? (
        <Text className="px-1 text-xs text-foreground-muted">
          Auto-merge e activ{pr.autoMergeMethod ? ` · ${pr.autoMergeMethod}` : ""}
        </Text>
      ) : null}
      {stack.error && stack.supportsStackActions ? (
        <Button label="Reîncearcă verificarea stack-ului" tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
