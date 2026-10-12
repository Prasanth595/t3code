import { describe } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-prepared-run");
const fixture = createOxlintRuleHarness("t3code/require-prepared-run", {
  filename: "historical.test.ts",
});

describe("prepared orchestration run construction", () => {
  rule.valid(
    "uses the private prepared boundary",
    `
    import * as Policy from "./SwarmExecutionPolicy.ts";
    const run = Policy.runFromPrepared(fields, prepared);
    export const event = { type: "run.created", payload: run };
  `,
  );
  rule.valid(
    "allows an aliased factory import",
    `
    import { runFromPrepared as create } from "./SwarmExecutionPolicy.ts";
    export const event = { type: "run.created", payload: create(fields, prepared) };
  `,
  );
  rule.invalid(
    "rejects the earlier raw run construction",
    `
    const run = { id: runId, ordinal: 1, delegatedTaskId: null, rootNodeId, swarmId };
    export const event = { type: "run.created", payload: run };
  `,
  );
  rule.invalid(
    "rejects copying an existing run into a new execution",
    `
    export const event = { type: "run.created", payload: { ...oldRun, id: nextRunId } };
  `,
  );
  rule.invalid(
    "does not accept a shadowed factory",
    `
    import * as Policy from "./SwarmExecutionPolicy.ts";
    function create(Policy) { return { type: "run.created", payload: Policy.runFromPrepared(fields, prepared) }; }
    export { create };
  `,
  );
  fixture.valid(
    "allows deliberate historical storage fixtures",
    `
    export const event = { type: "run.created", payload: { id: "old" } };
  `,
  );
});
