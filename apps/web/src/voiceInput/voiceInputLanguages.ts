/** Whisper languages the small local model transcribes reasonably well. */
export const VOICE_INPUT_LANGUAGES = [
  { code: "ar", label: "Arabic" },
  { code: "ca", label: "Catalan" },
  { code: "zh", label: "Chinese" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "no", label: "Norwegian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "es", label: "Spanish" },
  { code: "sv", label: "Swedish" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "vi", label: "Vietnamese" },
] as const;

const SUPPORTED_CODES = new Set<string>(VOICE_INPUT_LANGUAGES.map((language) => language.code));
// Older or alternate BCP 47 codes for the same Whisper languages.
const ALIASES: Readonly<Record<string, string>> = { iw: "he", in: "id", nb: "no", nn: "no" };

/** A supported Whisper language code, or null for automatic detection. */
export function normalizeVoiceInputLanguage(value: string): string | null {
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const code = ALIASES[primary] ?? primary;
  return SUPPORTED_CODES.has(code) ? code : null;
}
