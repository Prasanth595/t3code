import { memo } from "react";
import { BotIcon } from "lucide-react";
import type { AgentId, AgentSummary } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const EMPTY_AGENTS: ReadonlyArray<AgentSummary> = [];

export interface AgentPickerProps {
  agents?: ReadonlyArray<AgentSummary> | undefined;
  selectedAgentId?: AgentId | null | undefined;
  defaultAgentId?: AgentId | null | undefined;
  /** `undefined` inherits the project default; `null` explicitly selects none. */
  onSelectAgent: (agentId: AgentId | null | undefined) => void;
  allowNone?: boolean | undefined;
  size?: ComposerControlSize | undefined;
  disabled?: boolean | undefined;
  hidden?: boolean | undefined;
  className?: string | undefined;
  triggerClassName?: string | undefined;
}

export const AgentPicker = memo(function AgentPicker({
  agents = EMPTY_AGENTS,
  selectedAgentId,
  defaultAgentId = null,
  onSelectAgent,
  allowNone = false,
  size = "sm",
  disabled = false,
  hidden = false,
  className,
  triggerClassName,
}: AgentPickerProps) {
  const [open, setOpen] = useComposerMenuState(hidden);
  const menuProps = useComposerMenuProps();

  const activeAgent = selectedAgentId
    ? (agents.find((agent) => agent.id === selectedAgentId) ?? null)
    : null;

  const defaultAgent = defaultAgentId
    ? (agents.find((agent) => agent.id === defaultAgentId) ?? null)
    : null;

  const triggerLabel = activeAgent
    ? activeAgent.name
    : allowNone && selectedAgentId === null
      ? "No custom agent"
      : defaultAgent
        ? `${defaultAgent.name} (Default)`
        : "Agent";

  const handleValueChange = (value: string) => {
    if (!value || value === "default") {
      onSelectAgent(undefined);
    } else if (value === "none") {
      onSelectAgent(null);
    } else {
      onSelectAgent(value as AgentId);
    }
  };
  const selectedValue = allowNone
    ? selectedAgentId === undefined
      ? "default"
      : selectedAgentId === null
        ? "none"
        : selectedAgentId
    : (selectedAgentId ?? "default");

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            disabled={disabled}
            className={cn("gap-1.5", triggerClassName, className)}
            aria-label="Select custom agent"
          />
        }
      >
        <ComposerControlIcon icon={BotIcon} size={size} />
        <span data-composer-control-label className="max-w-28 truncate text-left sm:max-w-36">
          {triggerLabel}
        </span>
        {activeAgent?.tier ? (
          <Badge variant="outline" size="sm" className="hidden sm:inline-flex">
            {activeAgent.tier === "economy" ? "Economy" : "Reasoning"}
          </Badge>
        ) : null}
        <ComposerControlChevron size={size} />
      </MenuTrigger>

      <MenuPopup align="start" {...menuProps} className="w-64 max-w-[calc(100vw-2rem)]">
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            Custom Agents
          </div>
          <MenuRadioGroup value={selectedValue} onValueChange={handleValueChange}>
            <MenuRadioItem value="default" hideIndicator closeOnClick>
              <div className="flex w-full min-w-0 flex-col py-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">Project default</span>
                  {defaultAgent ? (
                    <Badge variant="outline" size="sm">
                      Inherits
                    </Badge>
                  ) : null}
                </div>
                <span className="text-muted-foreground text-xs">
                  {defaultAgent
                    ? `Uses ${defaultAgent.name} for new threads.`
                    : "Uses the project setting; no custom agent is configured."}
                </span>
              </div>
            </MenuRadioItem>

            {allowNone ? (
              <MenuRadioItem value="none" hideIndicator closeOnClick>
                <div className="flex w-full min-w-0 flex-col py-0.5">
                  <span className="font-medium truncate">No custom agent</span>
                  <span className="text-muted-foreground text-xs">
                    Ignore the project default for this thread.
                  </span>
                </div>
              </MenuRadioItem>
            ) : null}

            {agents.length > 0 ? <MenuDivider /> : null}

            {agents.map((agent) => {
              const isDefault = agent.id === defaultAgentId;
              return (
                <MenuRadioItem key={agent.id} value={agent.id} hideIndicator closeOnClick>
                  <div className="flex w-full min-w-0 flex-col py-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">{agent.name}</span>
                      <div className="flex items-center gap-1">
                        {isDefault ? (
                          <Badge variant="secondary" size="sm">
                            Default
                          </Badge>
                        ) : null}
                        {agent.tier ? (
                          <Badge variant="outline" size="sm">
                            {agent.tier === "economy" ? "Economy" : "Reasoning"}
                          </Badge>
                        ) : null}
                        {agent.model ? (
                          <Badge
                            variant="outline"
                            size="sm"
                            title={`Fixed model: ${agent.model.model}`}
                          >
                            {agent.model.model}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    {agent.description ? (
                      <span className="text-muted-foreground text-xs line-clamp-2">
                        {agent.description}
                      </span>
                    ) : null}
                  </div>
                </MenuRadioItem>
              );
            })}

            {agents.length === 0 ? (
              <div className="px-2 py-2 text-muted-foreground text-xs">
                No custom agents found in .agents/ or .github/agents/
              </div>
            ) : null}
            <div className="px-2 py-2 text-muted-foreground text-xs">
              An explicit composer model choice wins. Without a configured model or tier, the agent
              inherits the selected model. Instructions are sent on its first provider turn.
            </div>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
