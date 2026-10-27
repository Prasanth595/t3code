import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./snapshotProbe.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("keeps an entry's own name and capabilities over the driver default", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models = providerModelsFromSettings(
      [],
      ["bare", { slug: "named", name: "Named", capabilities }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "bare",
        name: "bare",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
      { slug: "named", name: "Named", isCustom: true, capabilities },
    ]);
  });

  it("renames a built-in model when a named entry uses its slug", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          shortName: "5.5",
          isCustom: false,
          capabilities,
        },
      ],
      [{ slug: "gpt-5.5", name: "Team GPT" }],
      capabilities,
    );

    expect(models).toEqual([{ slug: "gpt-5.5", name: "Team GPT", isCustom: false, capabilities }]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("buildServerProvider", () => {
  it.each([
    ["Claude Opus 5.5", ["Claude "], undefined, "Opus 5.5"],
    ["GPT-6.1-Sol", ["GPT-"], undefined, "6.1 Sol"],
    ["Grok 4 Pro", [], undefined, undefined],
    ["Claude Opus 5.5", [], undefined, "Opus 5.5"],
    ["NVIDIA: Nemotron 3 Super", [], undefined, "Nemotron 3 Super"],
    ["GPT-5.5", ["GPT-"], undefined, undefined],
    ["Claude Opus 5.5", ["Claude "], "Opus", "Opus"],
  ] as const)(
    "gives %s on families %j (explicit %s) the short name %s",
    (name, modelFamilies, shortName, expected) => {
      const provider = buildServerProvider({
        presentation: { displayName: "Test", modelFamilies },
        enabled: true,
        checkedAt: "2026-10-23T00:00:00Z",
        models: [
          {
            slug: "model",
            name,
            isCustom: false,
            capabilities: null,
            ...(shortName && { shortName }),
          },
        ],
        probe: {
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
        },
      });
      expect(provider.models[0]?.shortName).toBe(expected);
    },
  );
});

describe("parseGenericCliVersion", () => {
  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseGenericCliVersion("v22.19.0")).toBe("22.19.0");
  });

  it("parses a version embedded in other output", () => {
    expect(parseGenericCliVersion("codex-cli 0.53.0 (build abc)")).toBe("0.53.0");
  });

  it("ignores versions glued to other word characters", () => {
    expect(parseGenericCliVersion("build2.0.3artifact")).toBeNull();
  });
});

describe("ProviderCommandNotFoundError", () => {
  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});
