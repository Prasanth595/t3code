import type { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class DelegationPolicyError extends Schema.TaggedError<DelegationPolicyError>()(
  "DelegationPolicyError",
  {
    code: Schema.Literals([
      "delegation_depth_exceeded",
      "delegation_budget_exceeded",
      "delegation_enforcement_unsupported",
    ]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "delegation_depth_exceeded":
        return "Delegated children cannot launch further agents (maxDepth=1).";
      case "delegation_budget_exceeded":
        return "The root thread's shared active or lifetime delegation budget is exhausted.";
      case "delegation_enforcement_unsupported":
        return "Native spawning cannot be disabled for this provider. Governed execution is refused.";
    }
  }
}

export function delegationAdmissionError(
  policy: ServerSettings["delegationPolicy"],
  input: { readonly child: boolean; readonly active: number; readonly total: number },
): DelegationPolicyError | undefined {
  if (policy === null) return undefined;
  if (input.child) return new DelegationPolicyError({ code: "delegation_depth_exceeded" });
  if (input.active >= policy.maxActive || input.total >= policy.maxTotal) {
    return new DelegationPolicyError({ code: "delegation_budget_exceeded" });
  }
  return undefined;
}

export function nativeSpawnEnforcementError(driver: string): DelegationPolicyError | undefined {
  return driver === "codex" || driver === "claudeAgent"
    ? undefined
    : new DelegationPolicyError({ code: "delegation_enforcement_unsupported" });
}
