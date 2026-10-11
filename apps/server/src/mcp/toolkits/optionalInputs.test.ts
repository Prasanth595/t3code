import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";

const cases = [
  ["t3_thread_list", {}, "settled", false, "false"],
  ["t3_thread_read", { threadId: "thread-1" }, "afterPosition", 2, "2"],
  ["t3_thread_read", { threadId: "thread-1" }, "view", "activity", "invalid"],
  ["delegate_task", { task: "Inspect" }, "title", "Review", 12],
] as const;

describe("optional MCP inputs", () => {
  it.each(cases)("%s.%s treats null as omission", (name, input, key) => {
    const decode = Schema.decodeUnknownSync(OrchestratorToolkit.tools[name].parametersSchema);
    const decoded = decode({ ...input, [key]: null });
    expect(decoded).toHaveProperty(key, undefined);
    expect(decoded).toEqual(decode(input));
  });
  it.each(cases)(
    "%s.%s preserves valid values and rejects wrong types",
    (name, input, key, valid, invalid) => {
      const decode = Schema.decodeUnknownSync(OrchestratorToolkit.tools[name].parametersSchema);
      expect(decode({ ...input, [key]: valid })).toHaveProperty(key, valid);
      expect(() => decode({ ...input, [key]: invalid })).toThrow();
    },
  );
  it("delegate_task.target.model treats null as omission", () => {
    const decode = Schema.decodeUnknownSync(
      OrchestratorToolkit.tools.delegate_task.parametersSchema,
    );
    expect(decode({ task: "Inspect", target: { model: null } }).target?.model).toBeUndefined();
    expect(decode({ task: "Inspect", target: { model: null } })).toEqual(
      decode({ task: "Inspect", target: {} }),
    );
    expect(decode({ task: "Inspect", target: { model: "model-1" } }).target?.model).toBe("model-1");
    expect(() => decode({ task: "Inspect", target: { model: 12 } })).toThrow();
  });
});

it("normalizes null dimensions before preview cross-field checks", () => {
  const decode = Schema.decodeUnknownSync(PreviewToolkit.tools.preview_resize.parametersSchema);
  expect(decode({ mode: "fill", width: null })).toEqual(decode({ mode: "fill" }));
  expect(decode({ mode: "freeform", width: 800, height: 600 })).toMatchObject({
    width: 800,
    height: 600,
  });
  expect(() => decode({ mode: "fill", width: 100 })).toThrow();
  expect(() => decode({ mode: "freeform", width: "800", height: 600 })).toThrow();
});

it("project defaultModelSelection options null is omission before conversion", () => {
  const decode = Schema.decodeUnknownSync(ProjectToolkit.tools.t3_project_update.parametersSchema);
  const selection = { instanceId: "codex", model: "gpt-5" };
  const input = { projectId: "project-1", defaultModelSelection: selection };
  expect(
    decode({ ...input, defaultModelSelection: { ...selection, options: null } }),
  ).toStrictEqual(decode(input));
  const options = [{ id: "reasoningEffort", value: "high" }];
  expect(
    decode({ ...input, defaultModelSelection: { ...selection, options } }).defaultModelSelection
      ?.options,
  ).toStrictEqual(options);
  expect(() =>
    decode({ ...input, defaultModelSelection: { ...selection, options: false } }),
  ).toThrow();
});

it("preserves semantic nulls for clearing project settings", () => {
  const decode = Schema.decodeUnknownSync(ProjectToolkit.tools.t3_project_update.parametersSchema);
  const input = { projectId: "project-1", defaultModelSelection: null, projectIcon: null };
  expect(decode(input)).toStrictEqual(input);
});

it.each(["read_pull_request_guide", "write_pull_request_guides"] as const)(
  "%s treats optional target nulls as omission and preserves validation",
  (name) => {
    const decode = Schema.decodeUnknownSync(PullRequestsToolkit.tools[name].parametersSchema);
    const input = (target: object) =>
      name === "read_pull_request_guide" ? target : { pullRequests: [target] };
    const target = { repository: "owner/repo", number: 1 };
    expect(decode(input({ ...target, url: null, host: null }))).toEqual(decode(input(target)));
    const valid = { url: "https://github.com/owner/repo/pull/1", host: "github.com" };
    expect(decode(input(valid))).toStrictEqual(input(valid));
    expect(() => decode(input({ ...target, number: "1" }))).toThrow();
    expect(() => decode(input({ ...target, host: 12 }))).toThrow();
    if (name === "write_pull_request_guides") {
      expect(() => decode({ pullRequests: [] })).toThrow();
      expect(() => decode({ pullRequests: Array.from({ length: 21 }, () => target) })).toThrow();
      expect(() => decode({})).toThrow();
    }
  },
);
