import { useNavigate } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";

import { FactoryNavIcon } from "./FactoryNavIcon";
import { useFactorySupported } from "./useFactoryData";

/**
 * The sidebar footer's Factory link, hidden when no environment serves the factory. `Item` is the
 * footer's own utility button, passed in because the upstream file keeps it private; `onNavigate`
 * runs before navigating, for closing the mobile sidebar.
 */
export function FactorySidebarUtilityItem({
  Item,
  onNavigate,
}: {
  Item: ComponentType<{ icon: ReactNode; label: string; onClick: () => void }>;
  onNavigate: () => void;
}) {
  const supported = useFactorySupported();
  const navigate = useNavigate();
  if (!supported) return null;
  return (
    <Item
      icon={<FactoryNavIcon />}
      label="Factory"
      onClick={() => {
        onNavigate();
        void navigate({ to: "/factory" });
      }}
    />
  );
}
