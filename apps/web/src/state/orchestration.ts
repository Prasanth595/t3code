import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";

import { connectionAtomRuntime } from "../connection/runtime";

export const orchestrationEnvironment: ReturnType<typeof createOrchestrationEnvironmentAtoms> =
  createOrchestrationEnvironmentAtoms(connectionAtomRuntime);
