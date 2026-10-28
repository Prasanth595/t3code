import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { AudioLinesIcon, BotIcon, BrainIcon, ChevronDownIcon, SettingsIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { useComposerMenuProps } from "./composerEventScope";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";
import { getDisplayModelName } from "./providerIconUtils";
import { effortDescriptor } from "./VoiceCallButton.logic";

/** A radio row marked, when chosen, with the same bar the model picker uses. */
export function RadioRow({ className, children, ...props }: ComponentProps<typeof MenuRadioItem>) {
  return (
    <MenuRadioItem closeOnClick {...props}>
      <span className={cn("flex w-full min-w-0 items-center gap-1.5", className)}>
        {children}
        <MenuRadioItemIndicator className="ml-auto">
          <span className="h-5 w-0.75 rounded-full bg-primary" />
        </MenuRadioItemIndicator>
      </span>
    </MenuRadioItem>
  );
}

/** Which account takes the call, with which voice, and which model the call's chat runs on. */
export function VoiceCallMenu({
  open,
  onOpenChange,
  locked,
  instanceId,
  candidates,
  voice,
  voices,
  modelSelection,
  modelProviders,
  onChoose,
  onChooseVoice,
  onChooseModel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A call in progress keeps the choices it started with. */
  locked: boolean;
  instanceId: ProviderInstanceId;
  candidates: ReadonlyArray<ServerProvider>;
  voice: string | undefined;
  voices: ReadonlyArray<string>;
  modelSelection: ModelSelection | undefined;
  modelProviders: ReadonlyArray<ServerProvider>;
  onChoose: (instanceId: ProviderInstanceId) => void;
  onChooseVoice: (voice: string | undefined) => void;
  onChooseModel: (selection: ModelSelection | undefined) => void;
}) {
  const navigate = useNavigate();
  const menuProps = useComposerMenuProps();
  const effort = effortDescriptor(modelProviders, modelSelection);
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={<Button size="icon-tiny" variant="ghost-muted" aria-label="Voice call options" />}
      >
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" side="top" {...menuProps}>
        <MenuGroup>
          <MenuGroupLabel>Call with</MenuGroupLabel>
          <MenuRadioGroup
            value={instanceId}
            onValueChange={(value) => onChoose(value as ProviderInstanceId)}
          >
            {candidates.map((candidate) => (
              <RadioRow key={candidate.instanceId} value={candidate.instanceId} disabled={locked}>
                <ProviderInstanceIcon
                  driverKind={candidate.driver}
                  displayName={candidate.displayName ?? candidate.instanceId}
                  accentColor={candidate.accentColor}
                  showBadge={candidates.length > 1}
                  className="size-5"
                  iconClassName="size-4"
                />
                <span className="min-w-0 truncate">
                  {candidate.displayName ?? candidate.instanceId}
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  {candidate.auth.label}
                </span>
              </RadioRow>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger disabled={locked}>
            <AudioLinesIcon aria-hidden />
            Voice
          </MenuSubTrigger>
          <MenuSubPopup {...menuProps}>
            <MenuRadioGroup
              value={voice ?? ""}
              onValueChange={(value) => onChooseVoice(value || undefined)}
            >
              <RadioRow value="">Account default</RadioRow>
              {voices.map((name) => (
                <RadioRow key={name} value={name} className="capitalize">
                  {name}
                </RadioRow>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger disabled={locked}>
            <BotIcon aria-hidden />
            Model
          </MenuSubTrigger>
          <MenuSubPopup {...menuProps}>
            <MenuRadioGroup
              value={
                modelSelection
                  ? modelPickerModelKey(modelSelection.instanceId, modelSelection.model)
                  : ""
              }
              onValueChange={(key) => {
                const picked = parseModelPickerModelKey(key);
                onChooseModel(
                  picked ? createModelSelection(picked.instanceId, picked.slug) : undefined,
                );
              }}
            >
              <RadioRow value="">Voice account's default</RadioRow>
              {modelProviders.map((entry) => (
                <MenuGroup key={entry.instanceId}>
                  <MenuSeparator />
                  <MenuGroupLabel>{entry.displayName ?? entry.instanceId}</MenuGroupLabel>
                  {entry.models.map((model) => (
                    <RadioRow
                      key={model.slug}
                      value={modelPickerModelKey(entry.instanceId, model.slug)}
                    >
                      <ProviderInstanceIcon
                        driverKind={entry.driver}
                        displayName={entry.displayName ?? entry.instanceId}
                        accentColor={entry.accentColor}
                        className="size-5"
                        iconClassName="size-4"
                      />
                      <span className="min-w-0 truncate">{getDisplayModelName(model)}</span>
                    </RadioRow>
                  ))}
                </MenuGroup>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        {modelSelection && effort?.type === "select" && (
          <MenuSub>
            <MenuSubTrigger disabled={locked}>
              <BrainIcon aria-hidden />
              Effort
            </MenuSubTrigger>
            <MenuSubPopup {...menuProps}>
              <MenuRadioGroup
                value={effort.currentValue ?? ""}
                onValueChange={(value) =>
                  onChooseModel(
                    createModelSelection(
                      modelSelection.instanceId,
                      modelSelection.model,
                      value ? [{ id: effort.id, value }] : undefined,
                    ),
                  )
                }
              >
                {effort.options.map((option) => (
                  <RadioRow key={option.id} value={option.id}>
                    {option.label}
                  </RadioRow>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        )}
        <MenuItem onClick={() => void navigate({ to: "/settings/providers" })}>
          <SettingsIcon aria-hidden />
          Voice settings
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
