import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
} from "./AntigravityAcpSupport.ts";

import { antigravity140Session } from "./antigravity140.fixture.ts";
import { antigravityThirdPartySession } from "./antigravityThirdParty.fixture.ts";

const modelConfig = {
  id: "model",
  name: "Model",
  type: "select",
  currentValue: "gemini-default",
  options: [
    { value: "gemini-default", name: "Gemini default" },
    { value: "gemini-saved", name: "Gemini saved" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

function makeModelRuntime(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [modelConfig],
  failure?: EffectAcpErrors.AcpError,
) {
  const selections: string[] = [];
  const setModel = Effect.fn("AntigravityAcpSupportTest.setModel")(function* (model: string) {
    if (failure) return yield* failure;
    selections.push(model);
  });
  return {
    runtime: {
      getConfigOptions: Effect.succeed(configOptions),
      setModel,
      setSessionModel: () => Effect.die("ACP 1.3 selects models through config options"),
    },
    selections,
  };
}

describe("applyAntigravityAcpModelSelection", () => {
  it.effect("selects GPT-OSS when only session models are advertised", () =>
    Effect.gen(function* () {
      const selections: string[] = [];
      const model = "gpt-oss-120b-medium";
      expect(
        yield* applyAntigravityAcpModelSelection({
          runtime: {
            getConfigOptions: Effect.succeed([]),
            setModel: () => Effect.die("No model config option was advertised"),
            setSessionModel: (value) =>
              Effect.sync(() => {
                selections.push(value);
                return {};
              }),
          },
          models: antigravityThirdPartySession.models,
          model,
          mapError: (cause) => cause,
        }),
      ).toBe(model);
      expect(selections).toEqual([model]);
    }),
  );

  it.effect.each(["gpt-oss-120b-medium", "claude-sonnet-5-5-low", "gemini-3.8-flash-low"])(
    "selects concrete %s when the current GPT-OSS model omits thinking_level",
    (model) =>
      Effect.gen(function* () {
        const selections: string[] = [];
        const selected = yield* applyAntigravityAcpModelSelection({
          runtime: {
            getConfigOptions: Effect.succeed(antigravityThirdPartySession.configOptions),
            setModel: () => Effect.die("Grouped model options are not concrete IDs"),
            setSessionModel: (value) =>
              Effect.sync(() => {
                selections.push(value);
                return {};
              }),
          },
          models: antigravityThirdPartySession.models,
          model,
          mapError: (cause) => cause,
        });
        expect(selected).toBe(model);
        expect(selections).toEqual([model]);
      }),
  );

  it.effect("selects GPT-OSS from legacy flat and grouped model options", () =>
    Effect.gen(function* () {
      const option = { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" };
      for (const options of [
        [option],
        [{ groupId: "openai", name: "OpenAI", options: [option] }],
      ]) {
        const { runtime, selections } = makeModelRuntime([{ ...modelConfig, options }]);
        expect(
          yield* applyAntigravityAcpModelSelection({
            runtime,
            model: option.value,
            mapError: (cause) => cause,
          }),
        ).toBe(option.value);
        expect(selections).toEqual([option.value]);
      }
    }),
  );

  it.effect("restores the saved model instead of the cold-resume default", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime();
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );

  it.effect.each([undefined, null, ANTIGRAVITY_DEFAULT_MODEL])(
    "uses the native default for %s without sending an internal model ID",
    (requestedModel) =>
      Effect.gen(function* () {
        const { runtime, selections } = makeModelRuntime();
        const model = yield* applyAntigravityAcpModelSelection({
          runtime,
          model: requestedModel,
          mapError: (cause) => cause,
        });

        expect(model).toBe("gemini-default");
        expect(selections).toEqual([]);
      }),
  );

  it.effect("selects the manifest default for the alias when the account offers it", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime();
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        defaultModel: "gemini-saved",
        mapError: (cause) => cause,
      });
      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);

      const { runtime: other, selections: otherSelections } = makeModelRuntime();
      const fallback = yield* applyAntigravityAcpModelSelection({
        runtime: other,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        defaultModel: "gemini-not-offered",
        mapError: (cause) => cause,
      });
      expect(fallback).toBe("gemini-default");
      expect(otherSelections).toEqual([]);
    }),
  );

  it.effect.each(["gemini-removed", "Gemini saved", "gemini-saved[reasoning=high]"])(
    "rejects unavailable or non-native model ID %s without selecting a fallback",
    (model) =>
      Effect.gen(function* () {
        const { runtime, selections } = makeModelRuntime();
        const error = yield* applyAntigravityAcpModelSelection({
          runtime,
          model,
          mapError: (cause) => cause,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "AcpRequestError",
          code: -32602,
          errorMessage: expect.stringContaining(`'${model}' is unavailable`),
        });
        expect(selections).toEqual([]);
      }),
  );

  it.effect("accepts exact model IDs from grouped native options", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeModelRuntime([
        {
          ...modelConfig,
          options: [{ groupId: "gemini", name: "Gemini", options: modelConfig.options }],
        },
      ]);
      const model = yield* applyAntigravityAcpModelSelection({
        runtime,
        model: "gemini-saved",
        mapError: (cause) => cause,
      });

      expect(model).toBe("gemini-saved");
      expect(selections).toEqual(["gemini-saved"]);
    }),
  );
});

// Synthetic variants of the captured 1.4.0 advertisement, not 1.4.1 captures.
describe("synthetic ACP 1.4.0 selection edges", () => {
  const high = antigravity140Session.models.currentModelId;
  const low = "gemini-3.8-flash-low";

  it.effect.each([
    {
      name: "family without thinking",
      configOptions: antigravity140Session.configOptions.slice(0, 1),
    },
    {
      name: "thinking without family",
      configOptions: antigravity140Session.configOptions.slice(1),
    },
    { name: "session models without config", configOptions: [] },
  ])("selects concrete IDs for $name", ({ configOptions }) =>
    Effect.gen(function* () {
      const selections: string[] = [];
      const model = yield* applyAntigravityAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed(configOptions),
          setModel: () => Effect.die("Concrete IDs must use session/set_model"),
          setSessionModel: (id) =>
            Effect.sync(() => {
              selections.push(id);
              return {};
            }),
        },
        models: antigravity140Session.models,
        model: low,
        mapError: (cause) => cause,
      });
      expect(model).toBe(low);
      expect(selections).toEqual([low]);
    }),
  );

  it.effect("selects only Medium for a synthetic GPT-OSS single-level advertisement", () =>
    Effect.gen(function* () {
      const id = "gpt-oss-120b-medium";
      const { runtime, selections } = makeModelRuntime([
        {
          ...antigravity140Session.configOptions[0]!,
          currentValue: id,
          options: [{ value: id, name: "GPT-OSS 120B (Medium)" }],
        },
      ]);
      expect(
        yield* applyAntigravityAcpModelSelection({
          runtime,
          models: {
            currentModelId: id,
            availableModels: [{ modelId: id, name: "GPT-OSS 120B (Medium)" }],
          },
          model: id,
          mapError: (cause) => cause,
        }),
      ).toBe(id);
      expect(selections).toEqual([id]);
      expect(
        yield* applyAntigravityAcpModelSelection({
          runtime,
          model: "gpt-oss-120b-high",
          mapError: (cause) => cause,
        }).pipe(Effect.flip),
      ).toMatchObject({ code: -32602 });
    }),
  );

  it.effect("selects Low but never invents Medium for a synthetic Gemini Pro family", () =>
    Effect.gen(function* () {
      const low = "gemini-3.1-pro-low";
      const models = {
        currentModelId: "gemini-3.1-pro-high",
        availableModels: [
          { modelId: "gemini-3.1-pro-high", name: "Pro High" },
          { modelId: low, name: "Pro Low" },
        ],
      };
      const selections: string[] = [];
      const runtime = {
        getConfigOptions: Effect.succeed([
          {
            ...antigravity140Session.configOptions[0]!,
            currentValue: "gemini-3.1-pro",
            options: [{ value: "gemini-3.1-pro", name: "Pro" }],
          },
        ]),
        setModel: () => Effect.die("Do not select a family"),
        setSessionModel: (id: string) =>
          Effect.sync(() => {
            selections.push(id);
            return {};
          }),
      };
      expect(
        yield* applyAntigravityAcpModelSelection({
          runtime,
          models,
          model: low,
          mapError: (cause) => cause,
        }),
      ).toBe(low);
      expect(
        yield* applyAntigravityAcpModelSelection({
          runtime,
          models,
          model: "gemini-3.1-pro-medium",
          mapError: (cause) => cause,
        }).pipe(Effect.flip),
      ).toMatchObject({ code: -32602 });
      expect(selections).toEqual([low]);
    }),
  );

  it.effect.each([
    { suffix: "missing", defaultModel: low, expected: low },
    { suffix: "renamed-id", defaultModel: low, expected: low },
    { suffix: "missing-default", defaultModel: "removed-default", expected: high },
    { suffix: "no-default", defaultModel: undefined, expected: high },
  ])("falls back on resume when the saved ID is $suffix", ({ suffix, defaultModel, expected }) =>
    Effect.gen(function* () {
      const selections: string[] = [];
      const result = yield* applyAntigravityAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed(antigravity140Session.configOptions),
          setModel: () => Effect.die("Do not select a family"),
          setSessionModel: (id) =>
            Effect.sync(() => {
              selections.push(id);
              return {};
            }),
        },
        models: antigravity140Session.models,
        model: `saved-${suffix}`,
        allowUnavailableModel: true,
        defaultModel,
        mapError: (cause) => cause,
      });
      expect(result).toBe(expected);
      expect(selections).toEqual([expected]);
    }),
  );

  it.effect.each([
    {
      name: "unknown current",
      models: { ...antigravity140Session.models, currentModelId: "removed" },
    },
    { name: "empty catalog", models: { ...antigravity140Session.models, availableModels: [] } },
    { name: "blank current", models: { ...antigravity140Session.models, currentModelId: "" } },
  ])("leaves the native default alone for $name", ({ models }) =>
    Effect.gen(function* () {
      const result = yield* applyAntigravityAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed(antigravity140Session.configOptions),
          setModel: () => Effect.die("No valid selection"),
          setSessionModel: () => Effect.die("No valid selection"),
        },
        models,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        mapError: (cause) => cause,
      });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("does not suppress an unavailable explicit selection on a fresh session", () =>
    Effect.gen(function* () {
      const { runtime } = makeModelRuntime(antigravity140Session.configOptions);
      const error = yield* applyAntigravityAcpModelSelection({
        runtime,
        models: antigravity140Session.models,
        model: "removed",
        mapError: (cause) => cause,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: -32602 });
    }),
  );

  it.effect("keeps duplicate IDs and renamed display names out of selection semantics", () =>
    Effect.gen(function* () {
      const selections: string[] = [];
      const result = yield* applyAntigravityAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed(antigravity140Session.configOptions),
          setModel: () => Effect.die("Do not select a family"),
          setSessionModel: (id) =>
            Effect.sync(() => {
              selections.push(id);
              return {};
            }),
        },
        models: {
          ...antigravity140Session.models,
          availableModels: [
            ...antigravity140Session.models.availableModels,
            { modelId: low, name: "Renamed Low" },
          ],
        },
        model: low,
        mapError: (cause) => cause,
      });
      expect(result).toBe(low);
      expect(selections).toEqual([low]);
    }),
  );

  it.effect.each([
    EffectAcpErrors.AcpRequestError.invalidParams("Agent rejected the advertised ID"),
    new EffectAcpErrors.AcpTransportError({
      detail: "Connection lost",
      cause: new Error("Disconnected"),
    }),
  ])("does not turn an agent or transport failure into a resume fallback: %s", (failure) =>
    Effect.gen(function* () {
      const result = yield* applyAntigravityAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed(antigravity140Session.configOptions),
          setModel: () => Effect.die("Do not select a family"),
          setSessionModel: () => Effect.fail(failure),
        },
        models: antigravity140Session.models,
        model: low,
        allowUnavailableModel: true,
        mapError: (cause) => cause,
      }).pipe(Effect.flip);
      expect(result).toBe(failure);
    }),
  );

  it.effect("reapplies the reported current concrete model across an in-flight config update", () =>
    Effect.gen(function* () {
      const config = yield* Ref.make<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>(
        antigravity140Session.configOptions,
      );
      const selecting = yield* Deferred.make<void>();
      const updated = yield* Deferred.make<void>();
      const selections: string[] = [];
      const runtime = {
        getConfigOptions: Ref.get(config),
        setModel: () => Effect.die("Do not select a family"),
        setSessionModel: (id: string) =>
          Effect.gen(function* () {
            selections.push(id);
            yield* Deferred.succeed(selecting, undefined);
            yield* Deferred.await(updated);
            return {};
          }),
      };
      const pending = yield* applyAntigravityAcpModelSelection({
        runtime,
        models: antigravity140Session.models,
        model: high,
        mapError: (cause) => cause,
      }).pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(selecting), Fiber.join(pending));
      yield* Ref.set(config, antigravity140Session.configOptions.slice(0, 1));
      yield* Deferred.succeed(updated, undefined);
      expect(yield* Fiber.join(pending)).toBe(high);
      expect(
        yield* applyAntigravityAcpModelSelection({
          runtime,
          models: antigravity140Session.models,
          model: high,
          mapError: (cause) => cause,
        }),
      ).toBe(high);
      expect(selections).toEqual([high, high]);
    }),
  );
});

const imageAttachment = {
  type: "image",
  id: "thread-00000000-0000-4000-8000-000000000001",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
} satisfies ChatAttachment;

const textAttachment = {
  type: "file",
  id: "thread-00000000-0000-4000-8000-000000000002-tsx",
  name: "example.tsx",
  mimeType: "application/octet-stream",
  sizeBytes: 1,
} satisfies ChatAttachment;

const pdfAttachment = {
  type: "file",
  id: "thread-00000000-0000-4000-8000-000000000003-pdf",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1,
} satisfies ChatAttachment;

const makeAttachmentFixture = Effect.fn("AntigravityAcpSupportTest.makeAttachmentFixture")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentsDir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-antigravity-attachments-",
    });
    const write = Effect.fn("AntigravityAcpSupportTest.writeAttachment")(function* (
      attachment: ChatAttachment,
      content: string | Uint8Array,
    ) {
      const filePath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (filePath === null) throw new Error("Invalid test attachment path.");
      if (typeof content === "string") yield* fs.writeFileString(filePath, content);
      else yield* fs.writeFile(filePath, content);
      return { filePath, uri: (yield* path.toFileUrl(filePath)).href };
    });
    return { fs, attachmentsDir, write };
  },
);

it.layer(NodeServices.layer)("buildAntigravityPrompt", (it) => {
  it.effect("sends image bytes as native image content alongside the user prompt", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=",
        "base64",
      );
      yield* fixture.write(imageAttachment, bytes);
      const prompt = yield* buildAntigravityPrompt({
        input: "  Explain this image.  ",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([
        { type: "text", text: "Explain this image." },
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ]);
    }),
  );

  it.effect("embeds UTF-8 code from the selected environment and keeps the upload in place", () =>
    Effect.gen(function* () {
      const selectedEnvironment = yield* makeAttachmentFixture();
      const otherEnvironment = yield* makeAttachmentFixture();
      const source = '  const name = "caf\u00e9";\n';
      const upload = yield* selectedEnvironment.write(textAttachment, source);
      yield* otherEnvironment.write(textAttachment, "Different environment.");
      const prompt = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [textAttachment],
        attachmentsDir: selectedEnvironment.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([
        {
          type: "resource",
          resource: { uri: upload.uri, mimeType: "application/octet-stream", text: source },
        },
      ]);
      expect(yield* selectedEnvironment.fs.readFileString(upload.filePath)).toBe(source);
      expect(
        yield* selectedEnvironment.fs.readDirectory(selectedEnvironment.attachmentsDir),
      ).toHaveLength(1);
    }),
  );

  it.effect("keeps folded clipboard text out of native context", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const pastedText = {
        ...textAttachment,
        name: "pasted-text.txt",
        mimeType: "text/plain",
        source: { _tag: "pasted-text" as const },
      } satisfies ChatAttachment;
      yield* fixture.write(pastedText, "A very large crash report");

      const prompt = yield* buildAntigravityPrompt({
        input: "Inspect the pasted text only as needed.",
        attachments: [pastedText],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([{ type: "text", text: "Inspect the pasted text only as needed." }]);
    }),
  );

  it.effect.each([
    { name: "archive.zip", mimeType: "application/zip" },
    { name: "clip.mp4", mimeType: "video/mp4" },
    { name: "recording.aiff", mimeType: "audio/aiff" },
    { name: "large.pdf", mimeType: "application/pdf", sizeBytes: 75_000_000 },
    { name: "large.txt", mimeType: "text/plain", sizeBytes: 1024 * 1024 + 1 },
    { name: "large.wav", mimeType: "audio/wav", sizeBytes: 20 * 1024 * 1024 + 1 },
  ])("keeps $name as a file path without reading or spending the native media budget", (file) =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const attachment = { ...textAttachment, sizeBytes: 50 * 1024 * 1024, ...file };
      const upload = yield* fixture.write(attachment, "");
      yield* fixture.fs.truncate(upload.filePath, attachment.sizeBytes);
      const pdf = yield* fixture.write(pdfAttachment, "");
      yield* fixture.fs.truncate(pdf.filePath, 50 * 1024 * 1024);
      const input = `Inspect the file at ${upload.filePath}`;
      const prompt = yield* buildAntigravityPrompt({
        input,
        attachments: [attachment, pdfAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fixture.fs,
          stream: () => {
            throw new Error("Path attachments must not be read into the prompt");
          },
        }),
      );
      expect(prompt).toEqual([
        { type: "text", text: input },
        { type: "resource_link", uri: pdf.uri, name: "report.pdf", mimeType: "application/pdf" },
      ]);
    }),
  );

  it.effect.each([undefined, {}, { image: false, audio: false, embeddedContext: false }])(
    "keeps attachments path-only when native prompt capabilities are absent: %s",
    (promptCapabilities) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        const audio = {
          ...textAttachment,
          id: "unsupported-audio",
          name: "audio.wav",
          mimeType: "audio/wav",
        };
        const gifAttachment = {
          ...imageAttachment,
          id: "unsupported-gif",
          name: "animation.gif",
          mimeType: "image/gif",
        };
        const gif = yield* fixture.write(gifAttachment, "GIF89a");
        const image = yield* fixture.write(imageAttachment, "pixels");
        const pdf = yield* fixture.write(pdfAttachment, "%PDF-1.7");
        const text = yield* fixture.write(textAttachment, "hello");
        const sound = yield* fixture.write(audio, "RIFF");
        const input = `Read ${image.filePath}, ${gif.filePath}, ${pdf.filePath}, ${text.filePath}, and ${sound.filePath}`;
        const prompt = yield* buildAntigravityPrompt({
          input,
          attachments: [imageAttachment, gifAttachment, pdfAttachment, textAttachment, audio],
          attachmentsDir: fixture.attachmentsDir,
          promptCapabilities,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fixture.fs,
            stream: () =>
              Effect.die("Unnegotiated attachments must not be read").pipe(Stream.fromEffect),
          }),
        );
        expect(prompt).toEqual([{ type: "text", text: input }]);
        expect(
          yield* buildAntigravityPrompt({
            input: "Continue",
            attachments: [],
            attachmentsDir: fixture.attachmentsDir,
            promptCapabilities,
          }),
        ).toEqual([{ type: "text", text: "Continue" }]);
      }),
  );

  it.effect("sends supported audio files as native audio content", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const audioAttachment = {
        ...textAttachment,
        id: "recording-1",
        name: "recording.wav",
        mimeType: "audio/wav",
      } satisfies ChatAttachment;
      const bytes = Buffer.from("RIFF....WAVEfmt ", "latin1");
      yield* fixture.write(audioAttachment, bytes);
      const prompt = yield* buildAntigravityPrompt({
        input: "Transcribe this.",
        attachments: [audioAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      });

      expect(prompt).toEqual([
        { type: "text", text: "Transcribe this." },
        { type: "audio", data: bytes.toString("base64"), mimeType: "audio/wav" },
      ]);
    }),
  );

  it.effect.each([undefined, {}, { image: false }, { image: true }])(
    "keeps unsupported image formats path-only with capabilities %s",
    (promptCapabilities) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        const attachment = { ...imageAttachment, name: "animation.gif", mimeType: "image/gif" };
        const upload = yield* fixture.write(attachment, "GIF89a");
        const input = `Analyze the image at ${upload.filePath}`;
        const prompt = yield* buildAntigravityPrompt({
          input,
          attachments: [attachment],
          attachmentsDir: fixture.attachmentsDir,
          promptCapabilities,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fixture.fs,
            stream: () => Effect.die("Unsupported images must not be read").pipe(Stream.fromEffect),
          }),
        );

        expect(prompt).toEqual([{ type: "text", text: input }]);
      }),
  );

  it.effect("rejects oversized images using file size instead of upload metadata", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const upload = yield* fixture.write(imageAttachment, "");
      yield* fixture.fs.truncate(upload.filePath, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
      const error = yield* buildAntigravityPrompt({
        input: "Read this attachment.",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: expect.stringContaining("'screen.png' is too large"),
      });
    }),
  );

  it.effect("keeps PDF overflow on the file-path route", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const secondAttachment = {
        ...pdfAttachment,
        id: `${pdfAttachment.id}-second`,
        name: "second.pdf",
      };
      const first = yield* fixture.write(pdfAttachment, "");
      const second = yield* fixture.write(secondAttachment, "");
      yield* fixture.fs.truncate(first.filePath, (50 * 1024 * 1024) / 2);
      yield* fixture.fs.truncate(second.filePath, (50 * 1024 * 1024) / 2);
      const input = {
        input: `Read ${first.filePath} and ${second.filePath}`,
        attachments: [pdfAttachment, secondAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      };
      const prompt = yield* buildAntigravityPrompt(input);
      expect(prompt).toEqual([
        { type: "text", text: input.input },
        {
          type: "resource_link",
          uri: first.uri,
          name: "report.pdf",
          mimeType: "application/pdf",
        },
        {
          type: "resource_link",
          uri: second.uri,
          name: "second.pdf",
          mimeType: "application/pdf",
        },
      ]);

      yield* fixture.fs.truncate(second.filePath, (50 * 1024 * 1024) / 2 + 1);
      expect(yield* buildAntigravityPrompt(input)).toEqual([
        { type: "text", text: input.input },
        {
          type: "resource_link",
          uri: first.uri,
          name: "report.pdf",
          mimeType: "application/pdf",
        },
      ]);
    }),
  );

  it.effect("still rejects images when the native budget is full", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const pdf = yield* fixture.write(pdfAttachment, "");
      yield* fixture.fs.truncate(pdf.filePath, 50 * 1024 * 1024);
      yield* fixture.write(imageAttachment, new Uint8Array([1]));
      const error = yield* buildAntigravityPrompt({
        input: "Inspect both attachments.",
        attachments: [pdfAttachment, imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        errorMessage: expect.stringContaining("'screen.png' is too large"),
      });
    }),
  );

  it.effect("rejects aggregate overflow when a text upload grows after its size check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const pdf = yield* fixture.write(pdfAttachment, "");
      const text = yield* fixture.write(textAttachment, "a");
      yield* fixture.fs.truncate(pdf.filePath, 50 * 1024 * 1024 - 1);
      const error = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [pdfAttachment, textAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fixture.fs,
          stat: Effect.fn("AntigravityAcpSupportTest.growAfterStat")(function* (filePath: string) {
            const info = yield* fixture.fs.stat(filePath);
            if (filePath === text.filePath) {
              yield* fixture.fs.writeFileString(filePath, "ab");
            }
            return info;
          }),
        }),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "Attachment 'example.tsx' changed while being read and is too large.",
      });
    }),
  );

  it.effect.each([
    { bytes: new Uint8Array([0xff, 0xfe, 0x61]), message: "is not a UTF-8 text file" },
    { bytes: new Uint8Array([0x61, 0, 0x62]), message: "contains binary data" },
  ])("rejects binary data disguised as code: $message", ({ bytes, message }) =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      yield* fixture.write(textAttachment, bytes);
      const error = yield* buildAntigravityPrompt({
        input: undefined,
        attachments: [textAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: expect.stringContaining(message),
      });
    }),
  );

  it.effect("reports a missing upload instead of sending only the remaining text", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const error = yield* buildAntigravityPrompt({
        input: "Read this image.",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "Could not read attachment 'screen.png'.",
      });
    }),
  );
});
