import { LockIcon } from "lucide-react";

import { hasAgenticAccess, useMiraAccess } from "~/cloud/miraChat";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** Chat answers on its own; Agentic works on a connected computer and needs Pro. */
export function ChatModeSwitch({
  mode,
  onChat,
  onAgentic,
}: {
  readonly mode: "chat" | "agentic";
  readonly onChat?: () => void;
  readonly onAgentic?: () => void;
}) {
  const locked = !hasAgenticAccess(useMiraAccess());
  return (
    <ToggleGroup
      aria-label="Mode"
      value={[mode]}
      onValueChange={(next) => {
        if (next[0] === "chat" && mode !== "chat") onChat?.();
        if (next[0] === "agentic" && mode !== "agentic") onAgentic?.();
      }}
    >
      <Toggle value="chat">Chat</Toggle>
      <Toggle value="agentic" aria-label={locked ? "Agentic, available with Pro" : "Agentic"}>
        Agentic
        {locked ? <LockIcon aria-hidden className="size-3" /> : null}
      </Toggle>
    </ToggleGroup>
  );
}
