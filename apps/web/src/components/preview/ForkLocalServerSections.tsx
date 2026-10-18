import type { ScopedThreadRef } from "@t3tools/contracts";

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
        {section.entries.map(({ server, note }) => (
          <PreviewLocalServerCard
            key={`${server.host}:${server.port}`}
            threadRef={props.threadRef}
            server={server}
            note={note}
            onOpen={() => props.onOpenUrl(server.requestedUrl)}
          />
        ))}
      </DiscoveryList>
    </div>
  ));
}
