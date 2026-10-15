import type { MouseEvent, PointerEvent, ReactNode } from "react";

import { usePortalContext } from "./context.ts";
import { formatRoute, type Route } from "./route.ts";

/** A link inside a draggable card must not start a drag or select the card. */
const stop = (event: MouseEvent | PointerEvent) => event.stopPropagation();

/** A sticker that opens where its work is, or a plain sticker when there is nowhere to go. */
export function StickerLink(props: {
  readonly className: string;
  readonly href: string | null;
  readonly label: string;
  readonly children: ReactNode;
}) {
  if (props.href === null) return <span className={props.className}>{props.children}</span>;
  const external = props.href.startsWith("https://");
  return (
    <a
      className={`${props.className} sticker-link`}
      href={props.href}
      aria-label={props.label}
      data-tip={props.label}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      onPointerDown={stop}
      onClick={stop}
    >
      {props.children}
    </a>
  );
}

/** Text that opens a view or a panel (MM-1106). Inside a draggable card it does not start a drag. */
export function RouteLink(props: {
  readonly route: Route;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      className={props.className}
      href={formatRoute(props.route)}
      onPointerDown={stop}
      onClick={stop}
    >
      {props.children}
    </a>
  );
}

/** A client name that opens the client panel and keeps the current view (MM-1115). */
export function ClientLink(props: { readonly id: string; readonly children: ReactNode }) {
  const { route } = usePortalContext();
  return (
    <RouteLink route={{ view: route.view, selection: { _tag: "client", id: props.id } }}>
      {props.children}
    </RouteLink>
  );
}

/** A machine name that opens the machine panel and keeps the current view. */
export function MachineLink(props: { readonly id: string; readonly children: ReactNode }) {
  const { route } = usePortalContext();
  return (
    <RouteLink route={{ view: route.view, selection: { _tag: "machine", id: props.id } }}>
      {props.children}
    </RouteLink>
  );
}
