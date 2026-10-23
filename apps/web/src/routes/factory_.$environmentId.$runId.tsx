import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { FactoryRunPage } from "../factory/FactoryRunPage";

export const Route = createFileRoute("/factory_/$environmentId/$runId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: FactoryRunRoute,
});

function FactoryRunRoute() {
  const { environmentId, runId } = Route.useParams();
  // Keyed so another run starts at loading instead of showing the last one.
  return (
    <FactoryRunPage
      environmentId={environmentId as EnvironmentId}
      key={`${environmentId} ${runId}`}
      runId={runId}
    />
  );
}
