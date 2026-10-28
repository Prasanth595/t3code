import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "cache-control",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
  "x-t3-accept-temporary-threads",
] as const;

export const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"] as const;
