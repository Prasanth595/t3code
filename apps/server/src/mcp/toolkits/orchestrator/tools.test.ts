import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

interface PropertySchema {
  readonly maximum?: number;
  readonly description?: string;
  readonly anyOf?: ReadonlyArray<PropertySchema>;
}

// Codex shows models a TypeScript view of each tool that drops minimum, maximum and any
// description inside anyOf, so an enforced bound must be stated on the property itself.
it("states t3_thread_read numeric bounds in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, PropertySchema>>;
  };
  const bounded = Object.entries(schema.properties).flatMap(([name, property]) =>
    [property, ...(property.anyOf ?? [])]
      .filter((member) => member.maximum !== undefined && member.maximum < Number.MAX_SAFE_INTEGER)
      .map((member) => [name, property.description, member.maximum] as const),
  );
  expect(bounded.map(([name]) => name)).toEqual(["limit", "runLimit", "maxCharsPerItem"]);
  for (const [name, description, maximum] of bounded) {
    expect(description, name).toContain(String(maximum));
  }
});
