import type { ProviderInteractionMode } from "@t3tools/contracts";
import { BotIcon, PencilRulerIcon } from "lucide-react";
import { memo } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

/** Build shows only its icon; Plan also names itself, so the non-default mode is never missed. */
export const ComposerInteractionModeToggle = memo(function ComposerInteractionModeToggle(props: {
  interactionMode: ProviderInteractionMode;
  size?: ComposerControlSize;
  onToggle: () => void;
}) {
  const size = props.size ?? "sm";
  const isPlan = props.interactionMode === "plan";
  const tooltip = isPlan
    ? "Plan mode. Click to return to normal build mode"
    : "Build mode. Click to enter plan mode";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0 whitespace-nowrap"
            aria-pressed={isPlan}
            type="button"
            onClick={props.onToggle}
            aria-label={tooltip}
          />
        }
      >
        {isPlan ? (
          <ComposerControlIcon
            icon={PencilRulerIcon}
            size={size}
            className="text-current opacity-100"
          />
        ) : (
          <ComposerControlIcon
            icon={BotIcon}
            size={size}
            opticalSize={size === "xs" ? "default" : "large"}
          />
        )}
        {/* The compacted row (xs) keeps this icon-only, like the other controls there. */}
        {isPlan ? (
          <span data-composer-control-label className={size === "xs" ? "sr-only" : undefined}>
            Plan
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
});
