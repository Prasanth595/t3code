import type { MouseEvent, PointerEvent, ReactNode } from "react";

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
      className={`${props.className} sticker-link tip`}
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
