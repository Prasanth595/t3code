import { createFileRoute, redirect } from "@tanstack/react-router";

import { FactoryPage } from "../factory/FactoryPage";
import { validateFactorySearch } from "../factory/search";

export const Route = createFileRoute("/factory")({
  validateSearch: validateFactorySearch,
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: FactoryPage,
});
