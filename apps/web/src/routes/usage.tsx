import { createFileRoute, redirect } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import {
  readUsagePagePreferences,
  validateUsagePageSearch,
} from "../components/usage/usagePagePreferences";

export const Route = createFileRoute("/usage")({
  validateSearch: validateUsagePageSearch,
  beforeLoad: async ({ context, search }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    if (search.metric === undefined || search.windowDays === undefined) {
      const preferences = readUsagePagePreferences();
      // Record the entry view explicitly so later preference changes cannot rewrite its history.
      throw redirect({
        to: "/usage",
        search: {
          metric: search.metric ?? preferences.metric,
          windowDays: search.windowDays ?? preferences.windowDays,
        },
        replace: true,
      });
    }
  },
  component: UsagePage,
});
