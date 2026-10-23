import type { ServerProvider } from "@t3tools/contracts";

const MODEL_FAMILIES: ReadonlyArray<{ readonly prefix: string; readonly nativeDriver: string }> = [
  { prefix: "Claude ", nativeDriver: "claudeAgent" },
  { prefix: "GPT-", nativeDriver: "codex" },
  { prefix: "Gemini ", nativeDriver: "antigravity" },
  { prefix: "Muse ", nativeDriver: "muse" },
  { prefix: "Grok ", nativeDriver: "grok" },
];

// Words that rank a model within its family rather than name one. Off the
// family's native provider there is no icon saying which family "4 Pro" belongs to.
const TIER_WORDS = new Set([
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
]);

const VERSION = /^v?\d+(?:\.\d+)*$/i;

export function modelShortName(name: string, driver: string): string | undefined {
  const family = MODEL_FAMILIES.find((candidate) => name.startsWith(candidate.prefix));
  if (!family) return undefined;
  const rest = name.slice(family.prefix.length).trim();
  const words = rest
    .replace(/\(.*?\)/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const named = words.filter((word) => !VERSION.test(word));
  if (named.length === 0) return undefined;
  if (driver !== family.nativeDriver && named.every((word) => TIER_WORDS.has(word.toLowerCase()))) {
    return undefined;
  }
  return rest;
}

export function withModelShortNames(provider: ServerProvider): ServerProvider {
  let changed = false;
  const models = provider.models.map((model) => {
    if (model.shortName) return model;
    const shortName = modelShortName(model.name, provider.driver);
    if (!shortName) return model;
    changed = true;
    return { ...model, shortName };
  });
  return changed ? { ...provider, models } : provider;
}
