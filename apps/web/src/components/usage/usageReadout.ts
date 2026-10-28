import type { UsageDisplay } from "@t3tools/contracts";

export interface UsageReadout {
  /** The shown number, and how far the bar fills. */
  readonly percent: number;
  readonly label: "Left" | "Used";
  readonly word: "left" | "used";
  readonly text: string;
  /** Where even spending would be by now, on the same scale as `percent`. */
  readonly evenPace: {
    readonly percent: number;
    readonly windowText: string;
    readonly byNowText: string;
  } | null;
}

/**
 * Every usage readout goes through here so labels, bars and pace marks flip together. Inputs are
 * the remaining-side numbers the shared helpers already compute, so "used" is always their
 * complement and the default readout is unchanged.
 */
export function usageReadout(
  display: UsageDisplay,
  remainingPercent: number,
  windowLeftPercent: number | null,
): UsageReadout {
  const used = display === "used";
  const percent = used ? 100 - remainingPercent : remainingPercent;
  const word = used ? "used" : "left";
  const pace =
    windowLeftPercent === null ? null : used ? 100 - windowLeftPercent : windowLeftPercent;
  return {
    percent,
    label: used ? "Used" : "Left",
    word,
    text: `${percent}% ${word}`,
    evenPace:
      pace === null
        ? null
        : {
            percent: pace,
            windowText: `${pace}% of the window ${used ? "elapsed" : "left"}`,
            byNowText: `${pace}% ${word} by now`,
          },
  };
}

/** A reset gives quota back: more left, or less used. */
export function restoreText(display: UsageDisplay, restoresPercent: number): string {
  return `${display === "used" ? "−" : "+"}${restoresPercent}%`;
}

/**
 * The part of the bar a reset would give back, as left offset and width in percent. Showing what
 * is left, it sits on the empty end of the track; showing what is used, on the tail of the fill.
 */
export function refillSpan(
  display: UsageDisplay,
  readout: UsageReadout,
  refillPercent: number,
): { readonly start: number; readonly width: number; readonly onFill: boolean } | null {
  const used = display === "used" ? readout.percent : 100 - readout.percent;
  const width = Math.min(used, refillPercent);
  if (width <= 0) return null;
  const onFill = display === "used";
  return { start: onFill ? readout.percent - width : 100 - width, width, onFill };
}
