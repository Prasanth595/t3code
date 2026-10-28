import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function threadRelationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return "Pornește";
    case "running":
    case "in_progress":
      return "Rulează";
    case "pending":
    case "queued":
      return "În coadă";
    case "waiting":
    case "blocked":
      return "Așteaptă";
    case "completed":
      return "Gata";
    case "failed":
    case "error":
      return "Eșuat";
    case "cancelled":
    case "interrupted":
      return "Oprit";
    case "rolled_back":
      return "Anulat";
    case "resolved_native":
      return "Rezolvat (nativ)";
    case "resolved_portable":
      return "Rezolvat (portabil)";
    case "consumed":
      return "Consumat";
    case "superseded":
      return "Înlocuit";
    case "idle":
      return "Inactiv";
    default:
      return "Necunoscut";
  }
}

export function ThreadRelationshipIcon({
  driver,
  provider,
  status,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  status: string | null;
  fallbackIcon?: LucideIcon;
}) {
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
          status === "running" ||
            status === "in_progress" ||
            status === "pending" ||
            status === "waiting"
            ? "bg-info"
            : status === "failed" || status === "error"
              ? "bg-destructive"
              : status === "completed"
                ? "bg-success"
                : "bg-muted-foreground/45",
        )}
        aria-hidden="true"
      />
    </span>
  );
}
