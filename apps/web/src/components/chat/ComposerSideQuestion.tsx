import type { EnvironmentId } from "@t3tools/contracts";
import { CheckCircle2Icon, ChevronDownIcon, CircleAlertIcon, GitForkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

export interface SideQuestionExchange {
  readonly id: string;
  readonly question: string;
  readonly answer: string | null;
  readonly synthetic?: boolean;
}

export interface SideQuestionPanelState {
  readonly focusKey: string;
  readonly exchanges: ReadonlyArray<SideQuestionExchange>;
  readonly requestId: string | null;
  readonly error: string | null;
}

/**
 * The /btw answers, as an island floating at the right of the composer. Folded,
 * it is one line with the latest question, so the thread stays in view.
 */
export function ComposerSideQuestion({
  state,
  autoFocus,
  environmentId,
  cwd,
  forkBlockedReason,
  onAsk,
  onFork,
  onDismiss,
}: {
  readonly state: SideQuestionPanelState;
  /** Whether the input takes focus as it appears, which only an ask should cause. */
  readonly autoFocus: boolean;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  /** Why Fork is unavailable right now, or null when it can fork. */
  readonly forkBlockedReason: string | null;
  readonly onAsk: (question: string) => boolean;
  readonly onFork: () => Promise<void>;
  readonly onDismiss: () => void;
}) {
  const [value, setValue] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [forking, setForking] = useState(false);
  const latestRef = useRef<HTMLLIElement>(null);
  const pending = state.requestId !== null;
  // Asking again, from the composer or a bare /btw, opens a folded island.
  const [focusKey, setFocusKey] = useState(state.focusKey);
  if (focusKey !== state.focusKey) {
    setFocusKey(state.focusKey);
    setCollapsed(false);
  }
  useEffect(() => {
    if (!collapsed && state.exchanges.length > 0) {
      latestRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [collapsed, state.exchanges]);
  const submit = () => {
    const question = value.trim();
    if (!question || pending) return;
    if (onAsk(question)) setValue("");
  };
  const latest = state.exchanges.at(-1);
  const answered = state.exchanges.some((exchange) => exchange.answer !== null);
  const forkDisabledReason = pending
    ? "Fork once the answer finishes"
    : !answered
      ? "Fork after an answer arrives"
      : forkBlockedReason;
  const fork = () => {
    setForking(true);
    void onFork().finally(() => setForking(false));
  };
  return (
    // The strip beside the island stays click-through to the timeline.
    <div className="pointer-events-none mb-2 flex justify-end @container">
      <ComposerBanner.Root
        placement="floating"
        density={collapsed ? "comfortable" : "spacious"}
        role="region"
        aria-label="Side question"
        className="pointer-events-auto w-full @xl:w-3/4"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
          }
        }}
      >
        <ComposerBanner.Row className={cn(!collapsed && "items-start")}>
          <ComposerBanner.Icon className="h-(--composer-banner-icon-column)">
            {latest === undefined ? null : pending ? (
              <Spinner aria-hidden />
            ) : state.error !== null ? (
              <CircleAlertIcon className="text-destructive-foreground" />
            ) : (
              <CheckCircle2Icon className="text-success" />
            )}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
              onPointerDown={(event) => event.preventDefault()}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 text-sm font-medium text-foreground",
                  collapsed ? "truncate" : "line-clamp-2 py-1 sm:py-0.5",
                )}
              >
                {collapsed ? (latest?.question ?? "Side question") : "Side question"}
              </span>
              {collapsed && pending ? (
                <span className="shrink-0 text-xs text-muted-foreground">· Thinking…</span>
              ) : null}
            </button>
          </ComposerBanner.Content>
          <ComposerBanner.Actions className="h-(--composer-banner-icon-column) flex-nowrap gap-0.5">
            {state.exchanges.length > 1 ? (
              <ComposerBanner.Count aria-label={`${state.exchanges.length} questions`}>
                {state.exchanges.length}
              </ComposerBanner.Count>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={collapsed ? "Expand side question" : "Collapse side question"}
              onClick={() => setCollapsed(!collapsed)}
              onPointerDown={(event) => event.preventDefault()}
            >
              <ChevronDownIcon className={cn("size-3.5", collapsed && "rotate-180")} />
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {collapsed ? null : (
          <>
            {state.exchanges.length > 0 ? (
              // Scrolling the answer must close a file link's hover tooltip, or it
              // stays behind where the link used to be.
              <TooltipScrollDismissArea>
                <ComposerBanner.Scroll>
                  <ComposerBanner.Body className="pt-1 pe-2 text-sm">
                    <ol className="space-y-4">
                      {state.exchanges.map((exchange, index) => (
                        <li
                          key={exchange.id}
                          ref={index === state.exchanges.length - 1 ? latestRef : undefined}
                          className="space-y-1"
                        >
                          <p className="whitespace-pre-wrap font-medium text-muted-foreground">
                            {exchange.question}
                          </p>
                          {exchange.answer !== null ? (
                            <div>
                              <ChatMarkdown
                                text={exchange.answer}
                                cwd={cwd}
                                environmentId={environmentId}
                              />
                              {exchange.synthetic ? (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Claude returned a fallback response.
                                </p>
                              ) : null}
                            </div>
                          ) : pending ? (
                            <p role="status" className="text-muted-foreground">
                              Thinking…
                            </p>
                          ) : state.error ? (
                            <div className="flex items-center gap-2">
                              <p
                                role="alert"
                                className="min-w-0 flex-1 text-destructive-foreground"
                              >
                                {state.error}
                              </p>
                              <Button
                                type="button"
                                size="compact"
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
                  </ComposerBanner.Body>
                </ComposerBanner.Scroll>
              </TooltipScrollDismissArea>
            ) : null}
            <div className="mt-2 flex items-center gap-2 ps-8 sm:ps-7">
              <Input
                key={state.focusKey}
                autoFocus={autoFocus}
                size="compact"
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
                size="compact"
                variant="secondary"
                disabled={pending || !value.trim()}
                onClick={submit}
              >
                {pending ? "Asking…" : "Ask"}
              </Button>
            </div>
            <ComposerBanner.Row className="mt-2 border-t border-border/60 pt-1">
              <ComposerBanner.Content />
              <ComposerBanner.Actions>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="compact"
                        aria-disabled={forkDisabledReason !== null || undefined}
                        disabled={forking}
                        onClick={forkDisabledReason === null ? fork : undefined}
                      />
                    }
                  >
                    <GitForkIcon aria-hidden />
                    Fork
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {forkDisabledReason ?? "Open a new thread with these answers in the composer"}
                  </TooltipPopup>
                </Tooltip>
                <Button type="button" variant="ghost-muted" size="compact" onClick={onDismiss}>
                  Dismiss
                </Button>
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
          </>
        )}
      </ComposerBanner.Root>
    </div>
  );
}
