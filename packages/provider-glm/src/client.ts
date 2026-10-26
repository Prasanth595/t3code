import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { GlmSettings } from "./settings.ts";

export const glmClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("glm"),
  label: "GLM Agent",
  hasDefaultInstance: false,
  authMethodsDiscovery: true,
  registryAgentId: "glm-acp-agent",
  settingsSchema: GlmSettings,
  environmentFields: [
    { name: "Z_AI_API_KEY", label: "Coding Plan API key", sensitive: true },
    {
      name: "ACP_GLM_BASE_URL",
      label: "Coding Plan endpoint",
      placeholder: "https://api.z.ai/api/coding/paas/v4",
    },
  ],
  icon: {
    viewBox: "0 0 16 16",
    fill: { light: "#000000", dark: "#FFFFFF" },
    paths: [
      {
        d: "M8.07 1.333L6.618 3.302H.435L1.887 1.333h6.184zM15.503 12.699L14.052 14.667h-6.161l1.449-1.968h6.163zM16 1.333L6.176 14.667H0L9.824 1.333H16z",
        fillRule: "evenodd",
      },
    ],
  },
});
