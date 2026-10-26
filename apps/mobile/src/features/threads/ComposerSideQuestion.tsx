import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import type { SideQuestionPanelState } from "./sideQuestionPanel";

/**
 * The /btw answers, docked above the composer. It mirrors the web island: it
 * folds to the latest question, and Fork carries the answers into a new thread.
 */
export function ComposerSideQuestion({
  state,
  autoFocus,
  canFork,
  onAsk,
  onFork,
  onClose,
}: {
  readonly state: SideQuestionPanelState;
  /** Whether the input takes focus as it appears, which only an ask should cause. */
  readonly autoFocus: boolean;
  /** Whether the thread's latest turn has stopped, so a fork can branch from it. */
  readonly canFork: boolean;
  readonly onAsk: (question: string) => boolean;
  readonly onFork: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [forking, setForking] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Asking again, from the composer or a bare /btw, opens a folded panel.
  const [focusKey, setFocusKey] = useState(state.focusKey);
  if (focusKey !== state.focusKey) {
    setFocusKey(state.focusKey);
    setCollapsed(false);
  }
  // Focus follows opening or reopening the panel, never an answer arriving or
  // a return to the thread, so typing in the main composer is not pulled back here.
  useEffect(() => {
    if (autoFocus && state.focusKey > 0) inputRef.current?.focus();
  }, [autoFocus, state.focusKey]);
  const submit = () => {
    const question = draft.trim();
    if (question.length === 0 || state.pending) return;
    if (onAsk(question)) setDraft("");
  };
  const latest = state.exchanges.at(-1);
  const answered = state.exchanges.some((exchange) => exchange.answer !== null);
  const forkEnabled = canFork && answered && !state.pending && !forking;
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={collapsed ? "Expand side question" : "Collapse side question"}
        accessibilityState={{ expanded: !collapsed }}
        onPress={() => setCollapsed(!collapsed)}
        className="flex-row items-center gap-2 px-4 pt-3 pb-1 active:opacity-70"
      >
        {latest === undefined ? null : state.pending ? (
          <ActivityIndicator size="small" />
        ) : state.error !== null ? (
          <SymbolView
            name="exclamationmark.circle"
            size={14}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        ) : (
          <SymbolView
            name="checkmark.circle.fill"
            size={14}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        )}
        <Text
          className="min-w-0 flex-1 font-medium text-foreground"
          numberOfLines={collapsed ? 1 : 2}
        >
          {collapsed ? (latest?.question ?? "Side question") : "Side question"}
        </Text>
        {state.exchanges.length > 1 ? (
          <Text className="text-xs text-muted-foreground">{state.exchanges.length}</Text>
        ) : null}
        <SymbolView
          name={collapsed ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
      {collapsed ? null : (
        <>
          {state.exchanges.length > 0 ? (
            <ScrollView
              ref={scrollRef}
              bounces={false}
              keyboardShouldPersistTaps="handled"
              className="max-h-72"
              contentContainerClassName="gap-3 px-4 pt-1 pb-2"
              // Follow a new question down to its "Thinking…" row, but leave the
              // view alone when the answer lands so it opens at the answer's start.
              onContentSizeChange={() => {
                if (state.pending) scrollRef.current?.scrollToEnd({ animated: true });
              }}
            >
              {state.exchanges.map((exchange) => (
                <View key={exchange.id} className="gap-1">
                  <Text className="text-sm font-medium text-muted-foreground" selectable>
                    {exchange.question}
                  </Text>
                  {exchange.answer !== null ? (
                    <View>
                      <Text className="text-sm text-foreground" selectable>
                        {exchange.answer}
                      </Text>
                      {exchange.synthetic ? (
                        <Text className="text-xs text-muted-foreground">
                          Claude returned a fallback response.
                        </Text>
                      ) : null}
                    </View>
                  ) : exchange.id !== latest?.id ? null : state.pending ? (
                    <View accessibilityRole="progressbar" className="flex-row items-center gap-2">
                      <ActivityIndicator size="small" />
                      <Text className="text-sm text-muted-foreground">Thinking…</Text>
                    </View>
                  ) : state.error !== null ? (
                    <View className="flex-row items-center gap-2">
                      <Text
                        accessibilityRole="alert"
                        className="min-w-0 flex-1 text-sm text-destructive"
                      >
                        {state.error}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Retry side question"
                        hitSlop={8}
                        onPress={() => onAsk(exchange.question)}
                        className="rounded-full border border-separator px-3 py-1 active:opacity-60"
                      >
                        <Text className="text-xs font-medium text-foreground">Retry</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          ) : null}
          <View className="flex-row items-center gap-2 border-t border-separator px-4 py-2">
            <TextInput
              ref={inputRef}
              autoFocus={autoFocus}
              accessibilityLabel="Ask a side question"
              className="min-w-0 flex-1 py-1 text-sm text-foreground"
              placeholder={
                state.exchanges.length === 0
                  ? "Ask a question about this conversation…"
                  : "Ask a follow-up…"
              }
              placeholderTextColorClassName="accent-icon-muted"
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submit}
              submitBehavior="submit"
              returnKeyType="send"
            />
            <Pressable
              accessibilityLabel="Ask side question"
              accessibilityRole="button"
              disabled={state.pending || draft.trim().length === 0}
              onPress={submit}
              className="rounded-full bg-primary px-3 py-1.5 active:opacity-70 disabled:opacity-40"
            >
              <Text className="text-xs font-medium text-primary-foreground">
                {state.pending ? "Asking…" : "Ask"}
              </Text>
            </Pressable>
          </View>
          <View className="flex-row items-center justify-end gap-2 border-t border-separator px-4 py-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Fork side question into a new thread"
              accessibilityHint="Opens a new thread with these answers in the composer"
              disabled={!forkEnabled}
              onPress={() => {
                setForking(true);
                void onFork().finally(() => setForking(false));
              }}
              className="flex-row items-center gap-1.5 rounded-full border border-separator px-3 py-1 active:opacity-60 disabled:opacity-40"
            >
              <SymbolView
                name="arrow.triangle.branch"
                size={12}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
              <Text className="text-xs font-medium text-foreground">Fork</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss side question"
              hitSlop={8}
              onPress={onClose}
              className="rounded-full border border-separator px-3 py-1 active:opacity-60"
            >
              <Text className="text-xs font-medium text-foreground">Dismiss</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
