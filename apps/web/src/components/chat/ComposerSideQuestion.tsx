import type { EnvironmentId } from "@t3tools/contracts";
import { MessageCircleQuestionMarkIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import ChatMarkdown from "../ChatMarkdown";

export interface SideQuestionExchange {
  readonly id: string;
  readonly question: string;
  readonly answer: string | null;
  readonly synthetic?: boolean;
}

export interface SideQuestionPanelState {
  readonly threadKey: string;
  readonly focusKey: string;
  readonly exchanges: ReadonlyArray<SideQuestionExchange>;
  readonly requestId: string | null;
  readonly error: string | null;
}

export function ComposerSideQuestion({
  state,
  environmentId,
  cwd,
  onAsk,
  onDismiss,
}: {
  readonly state: SideQuestionPanelState;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly onAsk: (question: string) => boolean;
  readonly onDismiss: () => void;
}) {
  const [value, setValue] = useState("");
  const latestRef = useRef<HTMLLIElement>(null);
  const pending = state.requestId !== null;
  useEffect(() => {
    if (state.exchanges.length > 0) latestRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.exchanges]);
  const submit = () => {
    const question = value.trim();
    if (!question || pending) return;
    if (onAsk(question)) setValue("");
  };
  return (
    <section
      aria-label="Side question"
      className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <MessageCircleQuestionMarkIcon aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Side question</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Not added to the thread
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Close side question"
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      </div>
      {state.exchanges.length > 0 ? (
        <ol className="max-h-[min(20rem,35dvh)] space-y-4 overflow-y-auto border-t border-border px-3 py-3">
          {state.exchanges.map((exchange, index) => (
            <li
              key={exchange.id}
              ref={index === state.exchanges.length - 1 ? latestRef : undefined}
              className="space-y-2"
            >
              <p className="whitespace-pre-wrap text-sm font-medium">{exchange.question}</p>
              {exchange.answer !== null ? (
                <div className="text-sm">
                  <ChatMarkdown text={exchange.answer} cwd={cwd} environmentId={environmentId} />
                  {exchange.synthetic ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Claude returned a fallback response.
                    </p>
                  ) : null}
                </div>
              ) : pending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Thinking…
                </p>
              ) : state.error ? (
                <div className="flex items-center gap-2">
                  <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
                    {state.error}
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => onAsk(exchange.question)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex items-center gap-2 border-t border-border p-3">
        <Input
          key={state.focusKey}
          autoFocus
          aria-label="Ask a side question"
          placeholder={
            state.exchanges.length === 0
              ? "Ask a question about this conversation…"
              : "Ask a follow-up…"
          }
          value={value}
          onValueChange={setValue}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              submit();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending || !value.trim()}
          onClick={submit}
        >
          {pending ? "Asking…" : "Ask"}
        </Button>
      </div>
    </section>
  );
}
