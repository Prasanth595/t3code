import { createFileRoute } from "@tanstack/react-router";

import { AdhdModeView } from "../components/adhdMode/AdhdModeView";

export const Route = createFileRoute("/_chat/adhd")({
  component: AdhdModeView,
});
