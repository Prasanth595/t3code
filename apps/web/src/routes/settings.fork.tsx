import { createFileRoute } from "@tanstack/react-router";

import { ForkSettingsPanel } from "../components/settings/ForkSettings";

export const Route = createFileRoute("/settings/fork")({ component: ForkSettingsPanel });
