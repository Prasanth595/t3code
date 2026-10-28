import { MessageCircleDashedIcon } from "lucide-react";

export function SidebarTemporaryIndicator() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-secondary-label">
      <MessageCircleDashedIcon aria-hidden className="size-3 shrink-0" />
      Temporary
    </span>
  );
}
