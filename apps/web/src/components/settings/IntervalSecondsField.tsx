import { useState } from "react";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { normalizeIntervalSeconds } from "./SettingsPanels.logic";

/**
 * Keeps typing local and saves on blur or a stepper press. Saving each keystroke would
 * briefly apply partial values, such as 1 second on the way to 120, or 0 (off) after clearing.
 */
export function IntervalSecondsField({
  label,
  inputLabel,
  value,
  min,
  step,
  onCommit,
}: {
  label: string;
  inputLabel?: string;
  value: number;
  min: number;
  step: number;
  onCommit: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <NumberField
      value={draft}
      min={min}
      step={step}
      size="sm"
      className="w-32"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) {
          setDraft(value);
          return;
        }
        const seconds = normalizeIntervalSeconds(next, min);
        setDraft(seconds);
        if (seconds !== value) onCommit(seconds);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput
          aria-label={inputLabel ?? `${label.charAt(0).toUpperCase()}${label.slice(1)} in seconds`}
        />
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}
