import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationV2TurnItem, ScopedThreadRef } from "@t3tools/contracts";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { environmentThreadDetails } from "../../state/threads";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  backgroundWorkDetailsMarkdown,
  type BackgroundWorkRef,
  linksOnlyMarkdown,
  resolveBackgroundWorkDetails,
} from "./BackgroundWorkDetails.logic";

const EMPTY_TURN_ITEMS: ReadonlyArray<OrchestrationV2TurnItem> = [];

const selectBackgroundWorkDetails = (settings: { readonly backgroundWorkDetails: boolean }) =>
  settings.backgroundWorkDetails;

// Rows toggle on click, Enter, and Space. The popover is a React child of the row even
// though it renders in a portal, so its events would reach the row without this.
function stopRowClick(event: MouseEvent) {
  event.stopPropagation();
}
function stopRowKeys(event: KeyboardEvent) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

/**
 * Background work text with its markdown links clickable, rendered by the chat's
 * markdown renderer. The rest of the text stays plain, and a text without a link skips the
 * renderer. Plain text while the "Background work details" setting is off.
 */
export function BackgroundWorkText(props: {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const enabled = useClientSettings(selectBackgroundWorkDetails);
  const markdown = enabled ? linksOnlyMarkdown(props.text) : null;
  if (markdown === null) return props.text;
  return (
    <span className="contents" onClick={stopRowClick} onKeyDown={stopRowKeys}>
      <ChatMarkdown
        text={markdown}
        cwd={props.cwd}
        threadRef={props.threadRef ?? undefined}
        parseRawHtml={false}
        className="inline-block w-auto max-w-full truncate align-bottom text-inherit [&_p]:inline"
      />
    </span>
  );
}

/**
 * Makes the status icon of a background work row open its details. Renders the icon
 * unchanged while the "Background work details" setting is off.
 */
export function BackgroundWorkIcon(props: BackgroundWorkIconProps) {
  // Most timeline rows are not background work; they skip the settings subscription.
  return props.work.length === 0 ? props.children : <BackgroundWorkIconPopover {...props} />;
}

interface BackgroundWorkIconProps {
  readonly work: ReadonlyArray<BackgroundWorkRef>;
  /** Shown when the start of the work is unknown, such as a notification's summary. */
  readonly summary?: string | undefined;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}

function BackgroundWorkIconPopover(props: BackgroundWorkIconProps) {
  const enabled = useClientSettings(selectBackgroundWorkDetails);
  const threadRef = props.threadRef;
  if (!enabled || threadRef === null) return props.children;
  return (
    <span className="contents" onClick={stopRowClick} onKeyDown={stopRowKeys}>
      <Popover>
        <PopoverTrigger
          render={
            <Button size="icon-tiny" variant="ghost-muted" aria-label="Background work details" />
          }
        >
          {props.children}
        </PopoverTrigger>
        <PopoverPopup aria-label="Background work details" width="lg" padding="compact">
          <BackgroundWorkDetailsContent
            work={props.work}
            summary={props.summary}
            cwd={props.cwd}
            threadRef={threadRef}
          />
        </PopoverPopup>
      </Popover>
    </span>
  );
}

// Mounted only while the popover is open, so closed rows do not read the thread.
function BackgroundWorkDetailsContent(props: {
  readonly work: ReadonlyArray<BackgroundWorkRef>;
  readonly summary?: string | undefined;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
}) {
  const turnItems = useAtomValue(
    environmentThreadDetails.threadAtom(props.threadRef),
    (thread) => thread?.projection.turnItems ?? EMPTY_TURN_ITEMS,
  );
  return (
    <div className="max-h-[min(var(--available-height),28rem)] space-y-3 overflow-y-auto">
      {props.work.map((work, index) => {
        const details = resolveBackgroundWorkDetails(turnItems, work);
        const description = details.description ?? props.summary;
        return (
          <ChatMarkdown
            key={work.taskId ?? index}
            text={backgroundWorkDetailsMarkdown({ ...details, description })}
            cwd={props.cwd}
            threadRef={props.threadRef}
            parseRawHtml={false}
          />
        );
      })}
    </div>
  );
}
