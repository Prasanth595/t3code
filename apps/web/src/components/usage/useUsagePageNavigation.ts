import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  validateUsagePageSearch,
  type UsagePagePreferences,
} from "./usagePagePreferences";

export function useUsagePageNavigation() {
  const [savedPreferences, setSavedPreferences] = useState(readUsagePagePreferences);
  const search = useSearch({ strict: false, select: validateUsagePageSearch });
  const navigate = useNavigate();
  const preferences = {
    ...savedPreferences,
    metric: search.metric ?? savedPreferences.metric,
    windowDays: search.windowDays ?? savedPreferences.windowDays,
  };
  const updatePreferences = (patch: Partial<UsagePagePreferences>) => {
    const nextPreferences = { ...preferences, ...patch };
    setSavedPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
    if (
      nextPreferences.metric !== preferences.metric ||
      nextPreferences.windowDays !== preferences.windowDays
    ) {
      void navigate({
        to: "/usage",
        search: { metric: nextPreferences.metric, windowDays: nextPreferences.windowDays },
      });
    }
  };
  return { preferences, updatePreferences };
}
