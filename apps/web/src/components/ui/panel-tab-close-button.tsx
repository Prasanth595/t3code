import { X } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface PanelTabCloseButtonProps {
  label: string;
  onClick: () => void;
  tooltip?: string;
}

/**
 * Fades the trailing edge of a tab title that fills its `pr-2` row, while `PanelTabCloseButton`
 * floats over it. The clear 8px is the part of the title the button covers.
 */
export const panelTabTitleFadeClassName =
  "group-hover/tab:[mask-image:linear-gradient(to_left,transparent_8px,black_20px)] group-has-[:focus-visible]/tab:[mask-image:linear-gradient(to_left,transparent_8px,black_20px)] pointer-coarse:[mask-image:linear-gradient(to_left,transparent_8px,black_20px)]";

/**
 * Close action that follows the title in a `relative group/tab` row with `pr-2`. It floats over the
 * row's trailing edge, so it takes no space and the row never changes width. Shown on hover or
 * keyboard focus, and always on touch screens, which cannot hover.
 */
export function PanelTabCloseButton({ label, onClick, tooltip }: PanelTabCloseButtonProps) {
  const button = (
    <button
      type="button"
      className="cursor-pointer pointer-events-none absolute top-1/2 right-0.5 flex size-3.5 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 hover:bg-muted group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:pointer-events-auto group-has-[:focus-visible]/tab:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
      aria-label={label}
      onClick={onClick}
    >
      <X className="size-3" />
    </button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
