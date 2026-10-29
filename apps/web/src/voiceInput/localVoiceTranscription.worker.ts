import {
  env,
  pipeline,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
  type GenerationConfig,
  type ProgressInfo,
} from "@huggingface/transformers";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

import type {
  LocalVoiceWorkerRequest,
  LocalVoiceWorkerResponse,
} from "./localVoiceTranscriptionProtocol";

const MODEL_ID = "onnx-community/whisper-tiny";
// Pinned so an upstream push cannot change the weights users download.
const MODEL_REVISION = "ff4177021cc41f7db950912b73ea4fdf7d01d8e7";
const SAMPLE_RATE = 16_000;
const WHISPER_WINDOW_SECONDS = 30;

env.allowLocalModels = false;
const wasm = env.backends.onnx.wasm;
if (wasm) {
  // Transformers.js otherwise loads this runtime from a CDN; the app ships it instead.
  wasm.wasmPaths = { wasm: ortWasmUrl };
  // Threads need cross-origin isolation, which T3 Code does not enable.
  wasm.numThreads = 1;
}

let recognizer: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let reportedPercent = -1;

function post(response: LocalVoiceWorkerResponse) {
  self.postMessage(response, { transfer: [] });
}

function reportProgress(info: ProgressInfo) {
  if (info.status !== "progress_total") return;
  // Config files finish first; counting them would show 100% before the weights start.
  let loaded = 0;
  let total = 0;
  for (const [file, progress] of Object.entries(info.files)) {
    if (!file.endsWith(".onnx")) continue;
    loaded += progress.loaded;
    total += progress.total;
  }
  const percent = total > 0 ? Math.floor((loaded / total) * 100) : 0;
  if (percent === reportedPercent) return;
  reportedPercent = percent;
  post({ kind: "progress", percent });
}

function loadRecognizer() {
  recognizer ??= pipeline("automatic-speech-recognition", MODEL_ID, {
    revision: MODEL_REVISION,
    dtype: "q8",
    device: "wasm",
    progress_callback: reportProgress,
  });
  return recognizer;
}

/** Transformers.js forces English when no language is given, so detect it the way Whisper does. */
async function detectLanguage(asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array) {
  const { input_features } = await asr.processor(
    audio.subarray(0, SAMPLE_RATE * WHISPER_WINDOW_SECONDS),
  );
  // Multilingual Whisper checkpoints carry WhisperGenerationConfig's language table.
  const config = asr.model.generation_config as
    | (GenerationConfig & { readonly lang_to_id: Record<string, number> | null })
    | null;
  if (!config?.lang_to_id) return null;
  const { logits } = await asr.model({
    input_features,
    decoder_input_ids: new Tensor(
      "int64",
      BigInt64Array.of(BigInt(config.decoder_start_token_id)),
      [1, 1],
    ),
  });
  const scores = logits.data as Float32Array;
  let best: { readonly token: string; readonly score: number } | null = null;
  for (const [token, id] of Object.entries(config.lang_to_id)) {
    const score = scores[id] ?? Number.NEGATIVE_INFINITY;
    if (!best || score > best.score) best = { token, score };
  }
  // Tokens look like <|en|>.
  return best ? best.token.slice(2, -2) : null;
}

async function transcribe(audio: Float32Array, requestedLanguage: string | null) {
  const asr = await loadRecognizer();
  const language = requestedLanguage ?? (await detectLanguage(asr, audio));
  const output = (await asr(audio, {
    ...(language ? { language } : {}),
    task: "transcribe",
    chunk_length_s: WHISPER_WINDOW_SECONDS,
    stride_length_s: 5,
  })) as { readonly text: string } | ReadonlyArray<{ readonly text: string }>;
  return Array.isArray(output)
    ? output.map((chunk) => chunk.text).join(" ")
    : (output as { readonly text: string }).text;
}

self.addEventListener("message", (event: MessageEvent<LocalVoiceWorkerRequest>) => {
  const request = event.data;
  const work =
    request.kind === "load"
      ? loadRecognizer().then(() => "")
      : transcribe(request.audio, request.language);
  work.then(
    (text) => post({ kind: "done", id: request.id, text }),
    (error: unknown) =>
      post({
        kind: "failed",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
