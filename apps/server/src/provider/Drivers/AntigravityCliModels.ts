import { ANTIGRAVITY_DEFAULT_MODEL, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export const FALLBACK_ANTIGRAVITY_CLI_MODELS: ReadonlyArray<{
  readonly slug: string;
  readonly name: string;
}> = [
  { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { slug: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { slug: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { slug: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { slug: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { slug: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { slug: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { slug: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
  { slug: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { slug: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { slug: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

export function parseAntigravityCliModelsOutput(raw: string): ReadonlyArray<ServerProviderModel> {
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  const parsed: ServerProviderModel[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("fetching")) continue;

    // Output is typically tab-separated: "slug\tName" or space separated
    const parts = trimmed.split("\t");
    const slug = parts[0]?.trim();
    if (!slug || seen.has(slug)) continue;

    const name = parts[1]?.trim() || slug;
    seen.add(slug);

    const isFirst = parsed.length === 0;
    parsed.push({
      slug,
      name,
      isCustom: false,
      ...(isFirst ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] } : {}),
      capabilities: EMPTY_MODEL_CAPABILITIES,
    });
  }

  if (parsed.length === 0) {
    return FALLBACK_ANTIGRAVITY_CLI_MODELS.map((m, index) => ({
      slug: m.slug,
      name: m.name,
      isCustom: false,
      ...(index === 0 ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] } : {}),
      capabilities: EMPTY_MODEL_CAPABILITIES,
    }));
  }

  return parsed;
}

let cachedModels: ReadonlyArray<ServerProviderModel> | null = null;
let lastDiscoveryTime = 0;
const CACHE_TTL_MS = 60_000;

export const discoverAntigravityCliModels = Effect.fn("discoverAntigravityCliModels")(
  function* (input: {
    readonly executablePath: string;
    readonly environment?: NodeJS.ProcessEnv | undefined;
    readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined;
    readonly forceRefresh?: boolean | undefined;
  }) {
    const now = yield* Clock.currentTimeMillis;
    if (!input.forceRefresh && cachedModels && now - lastDiscoveryTime < CACHE_TTL_MS) {
      return cachedModels;
    }

    const spawnerOption = input.spawner
      ? Option.some(input.spawner)
      : yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);

    if (Option.isNone(spawnerOption)) {
      return (
        cachedModels ??
        FALLBACK_ANTIGRAVITY_CLI_MODELS.map((m, index) => ({
          slug: m.slug,
          name: m.name,
          isCustom: false,
          ...(index === 0 ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] } : {}),
          capabilities: EMPTY_MODEL_CAPABILITIES,
        }))
      );
    }

    const spawner = spawnerOption.value;
    const discovered = yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.executablePath, ["models"], {
          env: input.environment,
          extendEnv: true,
          shell: false,
          windowsHide: true,
        }),
      );
      const text = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.succeed("")),
      );
      yield* child.exitCode.pipe(
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.succeed(ChildProcessSpawner.ExitCode(0))),
      );
      return parseAntigravityCliModelsOutput(text);
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          FALLBACK_ANTIGRAVITY_CLI_MODELS.map((m, index) => ({
            slug: m.slug,
            name: m.name,
            isCustom: false,
            ...(index === 0 ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] } : {}),
            capabilities: EMPTY_MODEL_CAPABILITIES,
          })),
        ),
      ),
    );

    if (discovered.length > 0) {
      cachedModels = discovered;
      lastDiscoveryTime = now;
    }
    return discovered;
  },
);
