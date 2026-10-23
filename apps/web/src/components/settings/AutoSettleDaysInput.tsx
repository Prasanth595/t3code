import { useState } from "react";
import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts/settings";
import { Input } from "../ui/input";

export function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }

  return (
    <div className="w-full sm:w-24">
      <Input
        size="sm"
        type="number"
        min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          const parsed = Number(event.target.value);
          if (
            Number.isInteger(parsed) &&
            parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
            parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
          ) {
            setDraft(String(parsed));
            if (parsed !== value) onCommit(parsed);
          } else {
            setDraft(String(value));
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(String(value));
          }
        }}
        aria-label="Days of inactivity before auto-settle"
      />
    </div>
  );
}
