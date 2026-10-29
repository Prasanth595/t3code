#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import * as ProcessRunner from "../../apps/server/src/processRunner.ts";
import { nextPromptsEvaluationCases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
  },
});
if (!values.model || !values.out)
  throw new Error("Use --model <configured-model> --out <directory>.");
const model = values.model;
const outputDirectory = values.out;
const caseIds = values.case?.split(",");
const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompts: Schema.Array(Schema.String),
      latencyMs: Schema.Number,
    }),
  ),
);
const decodeResults = Schema.decodeUnknownEffect(Results);
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-next-prompts-evaluation-" });
    const generation = yield* CodexTextGeneration.makeCodexTextGeneration(
      yield* decodeSettings({}),
    );
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const answerKey = [];
    for (const fixture of nextPromptsEvaluationCases) {
      if (caseIds && !caseIds.includes(fixture.id)) continue;
      const previous = baseline.find((entry) => entry.id === fixture.id);
      if (values.baseline && !previous) throw new Error(`Baseline is missing ${fixture.id}.`);
      const [elapsed, generated] = yield* generation
        .generateNextPrompts({
          cwd,
          title: fixture.title,
          conversation: formatThreadTitleContext(fixture.messages).message,
          failed: fixture.failed,
          ...(fixture.failureMessage ? { failureMessage: fixture.failureMessage } : {}),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
        })
        .pipe(Effect.timed);
      results.push({
        id: fixture.id,
        prompts: generated.prompts,
        latencyMs: Duration.toMillis(elapsed),
      });
      if (!previous) {
        review.push({
          id: fixture.id,
          rubric: fixture.rubric,
          prompts: generated.prompts,
          pass: "",
        });
        continue;
      }
      const newFirst = NodeCrypto.randomInt(2) === 0;
      review.push({
        id: fixture.id,
        rubric: fixture.rubric,
        A: newFirst ? generated.prompts : previous.prompts,
        B: newFirst ? previous.prompts : generated.prompts,
        preferred: "",
      });
      answerKey.push({ id: fixture.id, candidate: newFirst ? "A" : "B" });
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    for (const [name, report] of [
      ["results", results],
      ["review", review],
      ...(values.baseline ? ([["answer-key", answerKey]] as const) : []),
    ] as const) {
      yield* fs.writeFileString(
        path.join(outputDirectory, `${name}.json`),
        yield* encodeReport(report),
      );
    }
    yield* Effect.log(`Wrote ${results.length} cases to ${outputDirectory}. Score review.json.`);
  }).pipe(
    Effect.provide(
      ProcessRunner.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-next-prompts-evaluation-state-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
