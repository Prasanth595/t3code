import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { makeAcpRegistryAdapterV2 } from "@t3tools/provider-acp-registry/testing";

export { readGlmPromptFailure } from "./server/promptFailure.ts";

export const GLM_PROVIDER = ProviderDriverKind.make("glm");
export const GLM_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(GLM_PROVIDER);

export function makeGlmAdapterV2(
  options: Omit<
    Parameters<typeof makeAcpRegistryAdapterV2>[0],
    "driverKind" | "itemIdentityDriver"
  >,
) {
  return makeAcpRegistryAdapterV2({
    ...options,
    driverKind: GLM_PROVIDER,
    itemIdentityDriver: ProviderDriverKind.make("acpRegistry"),
  });
}
