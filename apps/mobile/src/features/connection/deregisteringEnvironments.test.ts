import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DeregisteringEnvironments,
  settleDeregisteringEnvironments,
} from "./deregisteringEnvironments";

const attic = EnvironmentId.make("environment-attic");
const studio = EnvironmentId.make("environment-studio");

describe("settleDeregisteringEnvironments", () => {
  it("keeps an unlinked environment hidden while a stale listing still has it", () => {
    const deregistering: DeregisteringEnvironments = new Map([[attic, "unlinked"]]);

    expect(settleDeregisteringEnvironments(deregistering, new Set([attic]))).toBe(deregistering);
  });

  it("forgets an unlinked environment once a listing lacks it, so a re-link shows again", () => {
    const deregistering: DeregisteringEnvironments = new Map([
      [attic, "unlinked"],
      [studio, "unlinked"],
    ]);

    const settled = settleDeregisteringEnvironments(deregistering, new Set([studio]));

    expect([...settled]).toEqual([[studio, "unlinked"]]);
  });

  it("keeps a pending environment hidden while the unlink is still running", () => {
    const deregistering: DeregisteringEnvironments = new Map([[attic, "pending"]]);

    expect(settleDeregisteringEnvironments(deregistering, new Set())).toBe(deregistering);
  });
});
