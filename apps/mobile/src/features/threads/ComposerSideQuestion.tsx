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
 * The /btw result, docked above the composer. It mirrors the web panel: the
 * transcript gains nothing, and dismissing it throws the exchanges away.
 */
export function ComposerSideQuestion({
  state,
  onAsk,
  onClose,
}: {
  readonly state: SideQuestionPanelState;
  readonly onAsk: (question: string) => boolean;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<TextInputInstance>(null);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Focus follows opening or reopening the panel, never an answer arriving,
  // so typing in the main composer is not pulled back here.
  useEffect(() => {
    if (state.focusKey > 0) inputRef.current?.focus();
  }, [state.focusKey]);
  const submit = () => {
    const question = draft.trim();
    if (question.length === 0 || state.pending) return;
    if (onAsk(question)) setDraft("");
  };
  const latest = state.exchanges.at(-1);
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <View className="flex-row items-center gap-2 px-4 pt-3 pb-1">
        <Text className="font-medium text-foreground" numberOfLines={1}>
          Side question
        </Text>
        <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={1}>
          Not added to the thread
        </Text>
        <Pressable
          accessibilityLabel="Close side question"
          accessibilityRole="button"
          hitSlop={12}
          onPress={onClose}
          className="-me-1 p-1 active:opacity-60"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
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
              <Text className="text-sm font-medium text-foreground" selectable>
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
          autoFocus
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
    </View>
  );
}
