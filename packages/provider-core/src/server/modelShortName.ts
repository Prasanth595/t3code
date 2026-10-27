import type { ServerProviderModel } from "@t3tools/contracts";

const FAMILY_PREFIXES = ["Claude ", "GPT-", "Gemini ", "Muse ", "Grok "] as const;

// Words that describe a variant within a family rather than name a model. Off the
// family's native provider there is no icon saying which family "4 Pro" belongs to.
const VARIANT_WORDS = new Set([
  "pro",
  "flash",
  "mini",
  "max",
  "lite",
  "nano",
  "ultra",
  "plus",
  "fast",
  "turbo",
  "preview",
  "latest",
  "thinking",
  "reasoning",
  "build",
  "image",
  "vision",
  "audio",
  "live",
  "custom",
  "tools",
  "exp",
  "experimental",
  "chat",
  "tts",
  "stt",
  "non",
  "transcribe",
]);

const VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i;

const VENDOR_PREFIX = /^[A-Z][\w.&\- ]{0,24}: (?=\S)/;

function modelShortName(name: string, nativeFamilies: ReadonlyArray<string>): string | undefined {
  const unprefixed = name.replace(VENDOR_PREFIX, "");
  const short =
    withoutFamily(unprefixed, nativeFamilies) ?? (namesModel(unprefixed) ? unprefixed : name);
  return short === name ? undefined : short;
}

export function withModelShortNames(
  models: ReadonlyArray<ServerProviderModel>,
  nativeFamilies: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.shortName) return model;
    const shortName = modelShortName(model.name, nativeFamilies);
    return shortName ? { ...model, shortName } : model;
  });
}

function withoutFamily(name: string, nativeFamilies: ReadonlyArray<string>): string | undefined {
  const prefix = FAMILY_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (!prefix) return undefined;
  const rest = name.slice(prefix.length).trim();
  const keep = nativeFamilies.includes(prefix)
    ? nonVersionWords(rest).length > 0
    : namesModel(rest);
  if (!keep) return undefined;
  return /\s/.test(rest) ? rest : rest.replaceAll("-", " ");
}

function nonVersionWords(text: string): ReadonlyArray<string> {
  return text
    .replace(/\(.*?\)/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 0 && !VERSION.test(word));
}

function namesModel(text: string): boolean {
  return nonVersionWords(text).some((word) => !VARIANT_WORDS.has(word.toLowerCase()));
}
