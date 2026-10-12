import { createFileRoute, redirect } from "@tanstack/react-router";

import { seedSettingsMachine } from "../components/settings/settingsScopeNavigation";
import { useUiStateStore } from "../uiStateStore";

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context, params }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    throw redirect({
      to: "/settings/projects",
      // Opens on the environment the views are narrowed to, like any Settings entry.
      search: {
        project: params.projectKey,
        machine: seedSettingsMachine(
          { project: params.projectKey },
          useUiStateStore.getState().environmentSelection,
        )?.machine,
      },
      replace: true,
    });
  },
});
