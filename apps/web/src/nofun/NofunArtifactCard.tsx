import type { EnvironmentId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { PanelRightOpenIcon } from "lucide-react";

import type { ChatFileAttachment } from "~/types";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Group, GroupSeparator } from "../components/ui/group";
import { ArtifactOpenMenu } from "./ArtifactOpenMenu";
import { nofunArtifactAttachment } from "./artifactDisplay";
import { PersonaAvatar, usePersonaIdentity } from "./persona";
import { PinHtmlRenderButton } from "./shelf/PinHtmlRenderButton";

/**
 * A No Fun artifact as a compact row in the thread: title, badge, and a split
 * Open button (side panel; the menu adds browser and file manager). The whole
 * card opens it, like the frame's "Open in panel" button.
 */
export function NofunArtifactCard(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly onOpen?: ((attachment: ChatFileAttachment) => void) | undefined;
  readonly pinThreadId?: string | undefined;
  /** Replaces the persona badge ("No Fun", "CATCHES"), e.g. "Variant 2". */
  readonly label?: string | undefined;
}) {
  const persona = usePersonaIdentity(props.environmentId);
  const open = () => props.onOpen?.(nofunArtifactAttachment(props.htmlRender));
  return (
    <div
      role={props.onOpen ? "button" : undefined}
      tabIndex={props.onOpen ? 0 : undefined}
      aria-label={`Open ${props.htmlRender.title}`}
      data-nofun-artifact-card
      className="group/nofun-card flex min-w-0 cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card p-2 pe-2.5 text-card-foreground shadow-xs/5 transition-colors hover:border-foreground/20 hover:bg-accent/30"
      onClick={open}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          open();
        }
      }}
    >
      <PersonaAvatar persona={persona} className="size-9" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold text-sm tracking-tight">
          {props.htmlRender.title}
        </span>
        <span className="truncate font-mono text-3xs uppercase tracking-widest text-muted-foreground">
          Artifact
        </span>
      </span>
      <Badge size="sm" variant="secondary">
        {props.label ?? persona.label}
      </Badge>
      {/* The pin button is its own control; it must not also open the card. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Stops the card's click only. */}
      <span
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {props.pinThreadId === undefined ? null : (
          <PinHtmlRenderButton
            environmentId={props.environmentId}
            threadId={props.pinThreadId}
            htmlRender={props.htmlRender}
          />
        )}
        {props.onOpen === undefined ? (
          <ArtifactOpenMenu
            environmentId={props.environmentId}
            htmlRender={props.htmlRender}
            variant="outline"
          />
        ) : (
          <Group aria-label="Open artifact">
            <Button size="xs" variant="outline" onClick={open}>
              <PanelRightOpenIcon className="size-3.5" />
              Open
            </Button>
            <GroupSeparator />
            <ArtifactOpenMenu
              environmentId={props.environmentId}
              htmlRender={props.htmlRender}
              variant="outline"
            />
          </Group>
        )}
      </span>
    </div>
  );
}
