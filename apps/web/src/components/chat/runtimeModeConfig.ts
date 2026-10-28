import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supravegheat",
    description: "Întreabă înainte de comenzi și modificări de fișiere.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Acceptă automat editările",
    description: "Aprobă automat editările, întreabă înainte de alte acțiuni.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Automat",
    description: "Furnizorii compatibili aprobă acțiunile de rutină; ceilalți tot întreabă.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Acces complet",
    description: "Permite comenzi și editări fără confirmare.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
