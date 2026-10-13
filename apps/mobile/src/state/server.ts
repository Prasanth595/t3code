import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";
import { firstMobileThreadCardLayout } from "./thread-card-layout";
import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  usageLimitSources: true,
  usageLimitsCommand: true,
});
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const threadListEnvironmentsAtom = createThreadListEnvironmentsAtom(
  environmentServerConfigsAtom,
);

// Config updates other than settings keep the same layout object, so list rows
// keep their memo. Any settings update gives a new object and re-renders them once.
export const mobileThreadCardLayoutAtom = Atom.make((get) =>
  firstMobileThreadCardLayout(get(environmentServerConfigsAtom)),
);
