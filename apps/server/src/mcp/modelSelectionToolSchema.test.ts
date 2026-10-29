import { expect, it } from "@effect/vitest";
import { modelSelectionToolSchema } from "./modelSelectionToolSchema.ts";

it.each([
  ["t3_project_create", "defaultModelSelection"],
  ["t3_project_update", "defaultModelSelection"],
  ["t3_thread_launch", "modelSelection"],
  ["t3_thread_configure", "modelSelection"],
])("advertises typed fields for %s without mutating the input", (name, field) => {
  const selection = {
    type: "object",
    properties: {
      provider: { anyOf: [{}, { type: "null" }] },
      instanceId: { anyOf: [{}, { type: "null" }] },
      model: {},
      options: { anyOf: [{}, { type: "null" }] },
    },
    required: ["model"],
  };
  const input = {
    type: "object",
    properties: { [field]: { anyOf: [selection, { type: "null" }] } },
  };
  const snapshot = structuredClone(input);
  const result = modelSelectionToolSchema(name, input);
  expect(input).toEqual(snapshot);
  expect(result).toMatchObject({
    properties: {
      [field]: {
        anyOf: [
          {
            required: ["model"],
            properties: {
              provider: { type: "string" },
              instanceId: { type: "string" },
              model: { type: "string" },
              options: {
                type: "array",
                items: { required: ["id", "value"] },
              },
            },
          },
          { type: "null" },
        ],
      },
    },
  });
});

it("leaves unrelated tools untouched", () => {
  const input = { type: "object", properties: { modelSelection: { type: "object" } } };
  expect(modelSelectionToolSchema("unrelated_tool", input)).toBe(input);
});
