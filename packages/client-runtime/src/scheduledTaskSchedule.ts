import { isValidTimeZone } from "@t3tools/contracts";

/** Blank means the environment's local time; undefined means the text is not a known zone, which blocks saving. */
export function parseTimeZoneDraft(value: string): string | null | undefined {
  const zone = value.trim();
  if (zone === "") return null;
  // Intl matches names case-insensitively; store the canonical spelling.
  return isValidTimeZone(zone)
    ? Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
    : undefined;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Zones this client knows, starting with its own. */
export function timeZoneSuggestions(): ReadonlyArray<string> {
  const local = localTimeZone();
  const known =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [local, ...known.filter((zone) => zone !== local)];
}
