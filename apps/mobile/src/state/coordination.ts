import { createCoordinationEnvironmentAtoms } from "@t3tools/client-runtime/state/coordination";
import { connectionAtomRuntime } from "../connection/runtime";

export const coordinationEnvironment = createCoordinationEnvironmentAtoms(connectionAtomRuntime);
