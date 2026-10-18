import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { useThreadShell } from "~/state/entities";

import { ThreadContextChip } from "../ThreadContextChip";
import { DiscoveryList } from "../ui/discovery-list";
import { Separator } from "../ui/separator";
import type { ForkLocalServerSection } from "./forkLocalServerGroups";
import { PreviewLocalServerCard } from "./PreviewLocalServerCard";

/** Fork: the "Local servers" list in groups, with a thin labeled divider before each group. */
export function ForkLocalServerSections(props: {
  readonly threadRef: ScopedThreadRef;
  readonly sections: ReadonlyArray<ForkLocalServerSection>;
  readonly onOpenUrl: (url: string) => void;
}) {
  return props.sections.map((section) => (
    <div key={section.group} className="flex flex-col gap-2">
      {section.label ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className="shrink-0">{section.label}</span>
          <Separator className="flex-1" />
        </div>
      ) : null}
      <DiscoveryList>
        {section.entries.map(({ server, note, threadId }) => (
          <div key={`${server.host}:${server.port}`} className="flex items-center">
            <div className="min-w-0 flex-1">
              <PreviewLocalServerCard
                threadRef={props.threadRef}
                server={server}
                note={note}
                onOpen={() => props.onOpenUrl(server.requestedUrl)}
              />
            </div>
            {threadId ? (
              <StartedByThread environmentId={props.threadRef.environmentId} threadId={threadId} />
            ) : null}
          </div>
        ))}
      </DiscoveryList>
    </div>
  ));
}

/** Fork: "from <thread>", a link to the thread that started the server. Nothing for an unknown thread. */
function StartedByThread(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shell = useThreadShell({ environmentId: props.environmentId, threadId: props.threadId });
  if (!shell) return null;
  return (
    <div className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-1.5 pr-3 text-xs text-muted-foreground">
      <span className="shrink-0">from</span>
      <div className="flex min-w-0">
        <ThreadContextChip
          record={{
            environmentId: props.environmentId,
            threadId: props.threadId,
            title: shell.title,
          }}
        />
      </div>
    </div>
  );
}
