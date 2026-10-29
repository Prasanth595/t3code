import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useEffect, useState } from "react";

import { voiceInputUnsupportedReason } from "~/voiceInput/browserVoiceInput";
import { releaseLocalVoiceTranscription } from "~/voiceInput/localVoiceTranscription";
import {
  normalizeVoiceInputLanguage,
  VOICE_INPUT_LANGUAGES,
} from "~/voiceInput/voiceInputLanguages";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const AUTO_LANGUAGE = "auto";
const SYSTEM_MICROPHONE = "system";

/** Lists microphones without asking for access; names appear once voice input has been allowed. */
function useMicrophones(active: boolean): ReadonlyArray<MediaDeviceInfo> | null {
  const [microphones, setMicrophones] = useState<ReadonlyArray<MediaDeviceInfo> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the browser's device list and follows devicechange while settings are open
  useEffect(() => {
    if (!active) return;
    const mediaDevices = navigator.mediaDevices;
    let current = true;
    const refresh = () => {
      void mediaDevices.enumerateDevices().then(
        (devices) => {
          if (!current) return;
          // Before access is granted, browsers return one unnamed placeholder without an id.
          setMicrophones(
            devices.filter(
              (device) =>
                device.kind === "audioinput" &&
                device.deviceId !== "" &&
                device.deviceId !== "default",
            ),
          );
        },
        () => {
          if (current) setMicrophones([]);
        },
      );
    };
    refresh();
    mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      current = false;
      mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, [active]);
  return microphones;
}

export function VoiceInputSettingsSection() {
  const settings = useScopedSettings((current) => ({
    enabled: current.voiceInputEnabled,
    language: current.voiceInputLanguage,
    microphoneId: current.voiceInputMicrophoneId,
  }));
  const updateSettings = useUpdateScopedSettings();
  const unsupportedReason = voiceInputUnsupportedReason();
  const microphones = useMicrophones(settings.enabled && unsupportedReason === null);
  const language = normalizeVoiceInputLanguage(settings.language) ?? AUTO_LANGUAGE;
  const languageLabel =
    VOICE_INPUT_LANGUAGES.find((option) => option.code === language)?.label ??
    "Detect automatically";
  const selectedMicrophone = microphones?.find(
    (microphone) => microphone.deviceId === settings.microphoneId,
  );
  const microphoneMissing =
    settings.microphoneId !== "" &&
    microphones !== null &&
    microphones.length > 0 &&
    selectedMicrophone === undefined;
  const microphoneLabel =
    settings.microphoneId === ""
      ? "System default"
      : microphoneMissing
        ? "Unavailable microphone"
        : selectedMicrophone?.label || "Selected microphone";

  return (
    <SettingsSection id="voice-input-section" title="Voice input">
      <SettingsRow
        {...searchableSetting("voice-input")}
        description={
          unsupportedReason ??
          "Show a microphone in the composer. Speech is transcribed on this device and never uploaded. The first use downloads a 45 MB speech model from Hugging Face; nothing downloads until you start voice input."
        }
        resetAction={
          settings.enabled !== DEFAULT_CLIENT_SETTINGS.voiceInputEnabled ? (
            <SettingResetButton
              label="voice input"
              onClick={() =>
                updateSettings({ voiceInputEnabled: DEFAULT_CLIENT_SETTINGS.voiceInputEnabled })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => {
              updateSettings({ voiceInputEnabled: Boolean(checked) });
              if (!checked) releaseLocalVoiceTranscription();
            }}
            aria-label="Voice input"
          />
        }
      />
      {settings.enabled ? (
        <>
          <SettingsRow
            {...searchableSetting("voice-input-language")}
            description="Choosing your language is faster and more accurate than detecting it."
            resetAction={
              language !== AUTO_LANGUAGE ? (
                <SettingResetButton
                  label="voice input language"
                  onClick={() => updateSettings({ voiceInputLanguage: AUTO_LANGUAGE })}
                />
              ) : null
            }
            control={
              <Select
                value={language}
                onValueChange={(value) => {
                  if (typeof value === "string") updateSettings({ voiceInputLanguage: value });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-0 max-w-full"
                  aria-label="Voice input language"
                >
                  <SelectValue>{languageLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={AUTO_LANGUAGE}>Detect automatically</SelectItem>
                  {VOICE_INPUT_LANGUAGES.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("voice-input-microphone")}
            description={
              microphoneMissing
                ? "The selected microphone is not connected. Reconnect it or choose another."
                : microphones !== null && microphones.length === 0
                  ? "Microphone names appear after you allow voice input to use the microphone."
                  : "Used from the next recording."
            }
            resetAction={
              settings.microphoneId !== "" ? (
                <SettingResetButton
                  label="voice input microphone"
                  onClick={() => updateSettings({ voiceInputMicrophoneId: "" })}
                />
              ) : null
            }
            control={
              <Select
                value={settings.microphoneId === "" ? SYSTEM_MICROPHONE : settings.microphoneId}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  updateSettings({
                    voiceInputMicrophoneId: value === SYSTEM_MICROPHONE ? "" : value,
                  });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-0 max-w-full"
                  aria-label="Voice input microphone"
                >
                  <SelectValue>{microphoneLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={SYSTEM_MICROPHONE}>System default</SelectItem>
                  {settings.microphoneId !== "" && selectedMicrophone === undefined ? (
                    <SelectItem value={settings.microphoneId}>{microphoneLabel}</SelectItem>
                  ) : null}
                  {microphones?.map((microphone, index) => (
                    <SelectItem key={microphone.deviceId} value={microphone.deviceId}>
                      {microphone.label || `Microphone ${index + 1}`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
