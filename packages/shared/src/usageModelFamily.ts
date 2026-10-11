/**
 * Derives the vendor family of a model id, so Usage can group spend by who
 * made the model rather than by which harness ran it.
 *
 * Runs on the model id as buckets report it, which is after the server
 * applies the user's model aliases, so mapping a model also fixes its family.
 *
 * @module usageModelFamily
 */

export type ModelFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "cursor"
  | "meta"
  | "moonshot"
  | "zai"
  | "deepseek"
  | "xiaomi"
  | "alibaba"
  | "mistral"
  | "unknown";

export const MODEL_FAMILY_LABEL: Record<ModelFamily, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  cursor: "Cursor",
  meta: "Meta",
  moonshot: "Moonshot (Kimi)",
  zai: "Z.ai (GLM)",
  deepseek: "DeepSeek",
  xiaomi: "Xiaomi (MiMo)",
  alibaba: "Alibaba (Qwen)",
  mistral: "Mistral",
  unknown: "Other / unknown",
};

/** Stable reading order for charts, tables and rows; unknown always last. */
export const MODEL_FAMILY_ORDER = Object.keys(MODEL_FAMILY_LABEL) as readonly ModelFamily[];

// Families mirror the vendors behind T3's built-in harnesses plus
// slopalytics.com's Frontier and Notable lists; anything else stays Unknown
// unless a model alias maps it.

/** Vendor path segments, as routers and gateways spell them. They beat tokens. */
const VENDOR_SEGMENTS: ReadonlyMap<string, ModelFamily> = new Map([
  ["openai", "openai"],
  ["anthropic", "anthropic"],
  ["google", "google"],
  ["meta-llama", "meta"],
  ["meta", "meta"],
  ["moonshotai", "moonshot"],
  ["z-ai", "zai"],
  ["zai-org", "zai"],
  ["deepseek-ai", "deepseek"],
  ["qwen", "alibaba"],
  ["mistralai", "mistral"],
  ["x-ai", "xai"],
  ["xai", "xai"],
]);

/**
 * Family tokens, matched as whole words: at the start of the id or after a
 * separator, and followed by its end, a separator or a version digit
 * (`qwen3`, `gpt4o`), so `museum` and `mimosa` stay unknown.
 */
const FAMILY_TOKENS: readonly (readonly [ModelFamily, readonly string[]])[] = [
  ["anthropic", ["claude", "opus", "sonnet", "haiku", "fable"]],
  ["openai", ["gpt", "codex"]],
  ["google", ["gemini", "gemma"]],
  ["xai", ["grok"]],
  ["cursor", ["composer"]],
  ["meta", ["muse", "llama"]],
  ["moonshot", ["kimi"]],
  ["zai", ["glm"]],
  ["deepseek", ["deepseek"]],
  ["xiaomi", ["mimo"]],
  ["alibaba", ["qwen", "qwq"]],
  ["mistral", ["mistral", "mixtral", "codestral", "devstral", "magistral", "ministral", "pixtral"]],
];

const SEPARATOR = "[-_./:]";
const TOKEN_PATTERNS = FAMILY_TOKENS.map(
  ([family, tokens]) =>
    [
      family,
      new RegExp(`(?<=^|${SEPARATOR})(?:${tokens.join("|")})(?=$|${SEPARATOR}|\\d)`),
    ] as const,
);
/** OpenAI's o-series (o3, o4-mini) as a whole word, so `foo3` and `o3x` stay unknown. */
const O_SERIES = new RegExp(`(?<=^|${SEPARATOR})o\\d+(?=$|${SEPARATOR})`);
const BRACKET_VARIANT = /\[[^\]]*\]/g;

/** Where `pattern` first matches in `id`, or `Infinity`. */
function matchIndex(pattern: RegExp, id: string): number {
  return pattern.exec(id)?.index ?? Number.POSITIVE_INFINITY;
}

export function modelFamily(model: string): ModelFamily {
  const id = model.trim().toLowerCase().replace(BRACKET_VARIANT, "");

  // Region prefixes such as `us.` fall away here as segments of their own.
  for (const segment of id.split(/[/.]/)) {
    const family = VENDOR_SEGMENTS.get(segment);
    if (family !== undefined) return family;
  }

  // The earliest token names the model: `deepseek-r1-distill-llama` is
  // DeepSeek's. Ties keep declaration order.
  let best: ModelFamily = "unknown";
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const [family, pattern] of TOKEN_PATTERNS) {
    const index =
      family === "openai"
        ? Math.min(matchIndex(pattern, id), matchIndex(O_SERIES, id))
        : matchIndex(pattern, id);
    if (index < bestIndex) {
      best = family;
      bestIndex = index;
    }
  }
  return best;
}
