import {
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  AudioLinesIcon,
  BotIcon,
  ChevronDownIcon,
  MicIcon,
  MicOffIcon,
  SettingsIcon,
} from "lucide-react";
import { type ComponentProps, useState } from "react";

import { IDLE_STATE } from "@t3tools/client-runtime/voice-call";
import { cn } from "~/lib/utils";
import { useVoiceCall } from "~/hooks/useVoiceCall";
import { serverEnvironment } from "~/state/server";
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
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { VoiceCallIcon } from "./VoiceCallIcon";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";
import { getDisplayModelName } from "./providerIconUtils";
import { pickVoiceProvider, voiceCapableProviders } from "./VoiceCallButton.logic";

interface VoiceCallButtonProps {
  environmentId: EnvironmentId;
  cwd: string | undefined;
  /** Set for a saved thread, which lets the call read and message it. */
  threadId: ThreadId | undefined;
  /** The account the thread already runs on; calls start there when it offers them. */
  preferredInstanceId: ProviderInstanceId | undefined;
}

/** Offers a call on one of the accounts that can start one, chosen from its menu. */
export function VoiceCallButton({
  environmentId,
  cwd,
  threadId,
  preferredInstanceId,
}: VoiceCallButtonProps) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const [chosen, setChosen] = useState<ProviderInstanceId>();
  const [chosenVoice, setChosenVoice] = useState<string>();
  const [modelSelection, setModelSelection] = useState<ModelSelection>();
  const candidates = voiceCapableProviders(providers);
  const provider = pickVoiceProvider(candidates, chosen, preferredInstanceId);
  const voices = provider?.realtimeVoices ?? [];
  const voice = chosenVoice && voices.includes(chosenVoice) ? chosenVoice : undefined;
  return provider ? (
    <VoiceCallControls
      key={`${environmentId}:${provider.instanceId}:${cwd}:${threadId}:${voice}:${modelSelection?.instanceId}:${modelSelection?.model}`}
      environmentId={environmentId}
      instanceId={provider.instanceId}
      cwd={cwd}
      threadId={threadId}
      voice={voice}
      voices={voices}
      candidates={candidates}
      modelSelection={modelSelection}
      modelProviders={providers?.filter((entry) => entry.enabled) ?? []}
      onChoose={setChosen}
      onChooseVoice={setChosenVoice}
      onChooseModel={setModelSelection}
    />
  ) : null;
}

/** A radio row marked, when chosen, with the same bar the model picker uses. */
function RadioRow({ className, children, ...props }: ComponentProps<typeof MenuRadioItem>) {
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

/** Wave button: toggles a spoken call with the provider; shows mute while it is live. */
function VoiceCallControls({
  environmentId,
  instanceId,
  cwd,
  threadId,
  voice,
  voices,
  candidates,
  modelSelection,
  modelProviders,
  onChoose,
  onChooseVoice,
  onChooseModel,
}: Omit<VoiceCallButtonProps, "preferredInstanceId"> & {
  instanceId: ProviderInstanceId;
  voice: string | undefined;
  voices: ReadonlyArray<string>;
  candidates: ReadonlyArray<ServerProvider>;
  modelSelection: ModelSelection | undefined;
  modelProviders: ReadonlyArray<ServerProvider>;
  onChoose: (instanceId: ProviderInstanceId) => void;
  onChooseVoice: (voice: string | undefined) => void;
  onChooseModel: (selection: ModelSelection | undefined) => void;
}) {
  const { begin, active: session } = useVoiceCall({
    environmentId,
    instanceId,
    cwd,
    threadId,
    voice,
    modelSelection,
  });
  const state = session?.state ?? IDLE_STATE;
  const active = state.phase === "connecting" || state.phase === "live";
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const menuProps = useComposerMenuProps();

  const toggle = async () => {
    if (active) return session?.call.hangUp();
    const call = await begin();
    const { phase, error } = call.getSnapshot();
    if (phase !== "error") return;
    toastManager.add({
      type: "error",
      title: "Voice call failed",
      description: error ?? undefined,
    });
    return call.hangUp();
  };

  return (
    <div className="flex items-center gap-1">
      {state.phase === "live" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-pressed={state.muted}
                aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}
                onClick={session?.call.toggleMute}
              />
            }
          >
            {state.muted ? <MicOffIcon aria-hidden /> : <MicIcon aria-hidden />}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{state.muted ? "Unmute" : "Mute"}</TooltipPopup>
        </Tooltip>
      ) : null}
      <span className="group/voice relative flex">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant={active ? "secondary" : "ghost-muted"}
                aria-pressed={active}
                aria-label="Voice call"
                onClick={toggle}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenuOpen(true);
                }}
              />
            }
          >
            <VoiceCallIcon call={session} />
          </TooltipTrigger>
          <TooltipPopup side="top">{active ? "End voice call" : "Start voice call"}</TooltipPopup>
        </Tooltip>
        <span className="absolute -top-1.5 -right-1.5 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover/voice:opacity-100 has-data-popup-open:opacity-100">
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={
                <Button size="icon-tiny" variant="ghost-muted" aria-label="Voice call options" />
              }
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
                    <RadioRow
                      key={candidate.instanceId}
                      value={candidate.instanceId}
                      disabled={active}
                    >
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
                <MenuSubTrigger disabled={active}>
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
                <MenuSubTrigger disabled={active}>
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
              <MenuItem onClick={() => void navigate({ to: "/settings/providers" })}>
                <SettingsIcon aria-hidden />
                Voice settings
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
      </span>
    </div>
  );
}
