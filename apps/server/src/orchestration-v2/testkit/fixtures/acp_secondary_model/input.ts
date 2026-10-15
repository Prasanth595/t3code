import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

/**
 * Cline advertises `provider` and then `model`, both `category: "model"`. The
 * model picker selects the provider; the later `model` option is an ordinary
 * option descriptor, picked here as discovery publishes it after the provider
 * switch.
 */
export const CLINE_SECONDARY_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("acpRegistry"),
  model: "cline-pass",
  options: [{ id: "model", value: "cline-pass/muse-spark-1.3-contributor" }] as const,
} satisfies ModelSelection;
