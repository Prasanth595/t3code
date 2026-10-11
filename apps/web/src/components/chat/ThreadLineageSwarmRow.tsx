import type { ThreadSwarmGroup } from "@t3tools/client-runtime/state/thread-swarms";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ServerProvider, ThreadId } from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  SquareIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import {
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadLineageSwarmRow(props: {
  readonly group: ThreadSwarmGroup;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onMessage: ((threadId: ThreadId) => void) | undefined;
  readonly onStopMember: ((threadId: ThreadId) => void) | undefined;
  readonly onStop: (() => void) | undefined;
  readonly stoppingId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const membersId = useId();
  const { group } = props;
  const label = `Swarm · ${group.swarm.title}`;
  return (
    <li className="group" data-swarm-expanded={expanded ? "" : undefined}>
      <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
        <ThreadDetailsControl
          part="primary"
          multiline
          aria-expanded={expanded}
          aria-controls={membersId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}, ${group.members.length} members, ${group.summary}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <BotIcon aria-hidden className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-medium leading-4 text-foreground/85">
              {label}
            </span>
            <span
              className={`block truncate text-2xs font-normal ${group.inputCount > 0 ? "text-primary" : "text-muted-foreground"}`}
            >
              {group.members.length} members · {group.summary}
            </span>
          </span>
          <ChevronDownIcon
            aria-hidden
            className={`size-3.5 text-muted-foreground ${expanded ? "rotate-180" : ""}`}
          />
        </ThreadDetailsControl>
        {props.onStop ? (
          <>
            <span aria-hidden className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    part="secondary"
                    tone="destructive"
                    aria-label={`Stop swarm ${group.swarm.title}`}
                    disabled={props.stoppingId !== null}
                    onClick={props.onStop}
                  />
                }
              >
                {props.stoppingId === group.swarm.id ? (
                  <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                ) : (
                  <SquareIcon aria-hidden className="size-3 fill-current" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="left">Stop this swarm and close peer messaging</TooltipPopup>
            </Tooltip>
          </>
        ) : null}
      </div>
      {expanded ? (
        <ul
          id={membersId}
          className="m-0 list-none p-0 ps-6.5"
          aria-label={`${group.swarm.title} members`}
        >
          {group.members.map((member) => {
            const task = member.task;
            const agent = task === null ? undefined : projectedSubagentsToRuntime([task])[0];
            const provider = props.providers?.find(
              (entry) => entry.instanceId === task?.providerInstanceId,
            );
            const detail =
              member.thread === null
                ? "Thread unavailable"
                : member.thread.archivedAt !== null
                  ? "Archived"
                  : member.member.admission.state === "revoked"
                    ? "Peer access revoked"
                    : threadRelationshipStatusLabel(member.status);
            return (
              <li key={member.member.threadId}>
                <div className="group/member relative flex min-h-8 items-center rounded-lg">
                  <Tooltip>
                    <TooltipTrigger
                      delay={200}
                      render={
                        <ThreadDetailsControl
                          part="row"
                          aria-disabled={!member.canOpen}
                          aria-label={`Open ${member.title} chat, ${detail}`}
                          onClick={() =>
                            member.canOpen && props.onOpenThread(member.member.threadId)
                          }
                        />
                      }
                    >
                      <ThreadRelationshipIcon
                        driver={task?.driver}
                        provider={provider}
                        fallbackIcon={BotIcon}
                        status={member.status}
                      />
                      <span className="min-w-0 flex-1 truncate text-left">{member.title}</span>
                      <span className="shrink-0 text-2xs font-normal text-muted-foreground">
                        {detail}
                      </span>
                    </TooltipTrigger>
                    <ThreadHoverCardPopup side="left">
                      {task && agent ? (
                        <SubagentTooltipContent
                          title={member.title}
                          model={task.model}
                          providerInstanceId={task.providerInstanceId}
                          origin="app_owned"
                          modelSelection={task.modelSelection}
                          provider={provider}
                          providers={props.providers}
                          driver={task.driver}
                          elapsed={<AgentElapsed agent={agent} />}
                          status={member.status}
                          result={task.result}
                          progress={task.progress}
                          childThread={member.thread ?? undefined}
                        />
                      ) : (
                        <span>
                          {member.title} · {detail}
                        </span>
                      )}
                    </ThreadHoverCardPopup>
                  </Tooltip>
                  {member.canMessage && props.onMessage ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <ThreadDetailsControl
                            size="icon-xs"
                            part="icon"
                            aria-label={`Message ${member.title}`}
                            onClick={() => props.onMessage?.(member.member.threadId)}
                          />
                        }
                      >
                        <MessageSquareIcon aria-hidden className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="left">Open composer for {member.title}</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {member.canStop && props.onStopMember ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <ThreadDetailsControl
                            size="icon-xs"
                            part="icon"
                            tone="destructive"
                            disabled={props.stoppingId !== null}
                            aria-label={`Stop subagent ${member.title}`}
                            onClick={() => props.onStopMember?.(member.member.threadId)}
                          />
                        }
                      >
                        {props.stoppingId === member.member.threadId ? (
                          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                        ) : (
                          <SquareIcon aria-hidden className="size-3 fill-current" />
                        )}
                      </TooltipTrigger>
                      <TooltipPopup side="left">Stop member</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
                {member.inputThreads.map((thread) => (
                  <ThreadDetailsControl
                    key={thread.id}
                    part="row"
                    tone="primary"
                    onClick={() => props.onOpenThread(thread.id)}
                  >
                    <span className="min-w-0 flex-1 truncate text-left">
                      Open question · {thread.title}
                    </span>
                  </ThreadDetailsControl>
                ))}
                {member.backgroundWork ? (
                  <p className="m-0 px-2.5 pb-1 text-2xs text-muted-foreground">
                    {member.backgroundWork.title}
                  </p>
                ) : null}
                {member.queuedCount > 0 ? (
                  <p className="m-0 px-2.5 pb-1 text-2xs text-muted-foreground">
                    {member.queuedCount} queued
                    {member.heldCount > 0 ? `, ${member.heldCount} held` : ""}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
