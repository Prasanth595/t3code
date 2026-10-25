import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { piClient } from "@t3tools/provider-pi/client";

export const providerClients = makeProviderClientRegistry([piClient]);
