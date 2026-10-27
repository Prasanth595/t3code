import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { loadBundledSkillSources } from "./bundledSkillSources.ts";

it.effect("ships both complete skills and their licenses", () =>
  Effect.gen(function* () {
    const sources = yield* loadBundledSkillSources();
    expect(sources.map((skill) => skill.id)).toEqual(["t3code-threads", "t3code-orchestration"]);
    for (const source of sources) {
      expect(source.files["SKILL.md"]).toContain(`name: ${source.id}`);
      expect(source.files.LICENSE).toContain("Copyright (c) 2026 Lovecast Inc.");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
