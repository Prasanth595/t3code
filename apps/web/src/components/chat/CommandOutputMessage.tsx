import { SquareTerminalIcon } from "lucide-react";
import { use } from "react";
import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "./MessageCopyButton";
import { TimelineRowCtx } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL } from "./TimelineRowParts";

export function CommandOutputMessage({
  text,
  localCommand,
  streaming,
}: {
  text: string;
  localCommand: string;
  streaming: boolean;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="w-fit min-w-0 max-w-full rounded-lg border border-border/70 bg-muted/30">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        <SquareTerminalIcon className="size-3.5 shrink-0" />
        {localCommand ? (
          <span className="min-w-0 break-all font-mono text-foreground">/{localCommand}</span>
        ) : (
          <span>Command output</span>
        )}
        {!streaming && (
          <div className="ml-auto pl-3 opacity-0 pointer-coarse:opacity-100 group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100">
            <MessageCopyButton text={text} label="Copy command output" variant="ghost" />
          </div>
        )}
      </div>
      <div
        className="max-h-96 min-w-0 overflow-y-auto px-3 py-2 text-sm text-foreground/85"
        data-thread-find-text="true"
      >
        <ChatMarkdown
          text={text}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          isStreaming={streaming}
          lineBreaks
          skills={ctx.skills}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onImageExpand={ctx.onImageExpand}
        />
      </div>
    </div>
  );
}
