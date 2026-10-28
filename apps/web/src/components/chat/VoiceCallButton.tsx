import {
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { MicIcon, MicOffIcon } from "lucide-react";
import { useRef, useState } from "react";

import { IDLE_STATE } from "@t3tools/client-runtime/voice-call";
import { useVoiceCall } from "~/hooks/useVoiceCall";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceCallIcon } from "./VoiceCallIcon";
import { VoiceCallMenu } from "./VoiceCallMenu";
import { VoiceDeviceMenu } from "./VoiceDeviceMenu";
import { useLongPress } from "./useLongPress";
import {
  chatModelProviders,
  pickVoiceProvider,
  voiceCapableProviders,
} from "./VoiceCallButton.logic";

/** The options arrow tucked at a button's corner: shown on hover, and not tappable on touch, where holding the button opens it. */
const OPTIONS_CORNER =
  "absolute -top-1.5 -right-1.5 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover/voice:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:pointer-events-none [@media(hover:none)]:pointer-events-none";

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
      key={`${environmentId}:${provider.instanceId}:${cwd}:${threadId}:${voice}:${modelSelection?.instanceId}:${modelSelection?.model}:${modelSelection?.options?.[0]?.value}`}
      environmentId={environmentId}
      instanceId={provider.instanceId}
      cwd={cwd}
      threadId={threadId}
      voice={voice}
      voices={voices}
      candidates={candidates}
      modelSelection={modelSelection}
      modelProviders={chatModelProviders(providers, candidates)}
      onChoose={setChosen}
      onChooseVoice={setChosenVoice}
      onChooseModel={setModelSelection}
    />
  ) : null;
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

  const [devicesOpen, setDevicesOpen] = useState(false);
  const starting = useRef(false);
  const waveHold = useLongPress(() => setMenuOpen(true));
  const micHold = useLongPress(() => setDevicesOpen(true));
  const toggle = async () => {
    if (waveHold.wasLongPress()) return;
    if (active) return session?.call.hangUp();
    if (starting.current) return;
    starting.current = true;
    const call = await begin().finally(() => {
      starting.current = false;
    });
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
      {state.phase === "live" && session ? (
        <span className="group/voice relative flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-pressed={state.muted}
                  aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}
                  onClick={() => micHold.wasLongPress() || session.call.toggleMute()}
                  {...micHold.handlers}
                />
              }
            >
              {state.muted ? <MicOffIcon aria-hidden /> : <MicIcon aria-hidden />}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{state.muted ? "Unmute" : "Mute"}</TooltipPopup>
          </Tooltip>
          <span className={OPTIONS_CORNER}>
            <VoiceDeviceMenu
              open={devicesOpen}
              onOpenChange={setDevicesOpen}
              microphoneId={state.microphoneId}
              speakerId={state.speakerId}
              onChooseMicrophone={session.call.selectMicrophone}
              onChooseSpeaker={session.call.selectSpeaker}
            />
          </span>
        </span>
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
                {...waveHold.handlers}
              />
            }
          >
            <VoiceCallIcon call={session} />
          </TooltipTrigger>
          <TooltipPopup side="top">{active ? "End voice call" : "Start voice call"}</TooltipPopup>
        </Tooltip>
        <span className={OPTIONS_CORNER}>
          <VoiceCallMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            locked={active}
            instanceId={instanceId}
            candidates={candidates}
            voice={voice}
            voices={voices}
            modelSelection={modelSelection}
            modelProviders={modelProviders}
            onChoose={onChoose}
            onChooseVoice={onChooseVoice}
            onChooseModel={onChooseModel}
          />
        </span>
      </span>
    </div>
  );
}
