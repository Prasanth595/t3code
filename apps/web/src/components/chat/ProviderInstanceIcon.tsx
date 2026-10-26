import { type CSSProperties, memo } from "react";

import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
} from "@t3tools/client-runtime/state/provider-instance-display";

import type { ProviderDriverKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";

export function providerTextColor(driverKind: ProviderDriverKind): {
  readonly className?: string;
  readonly style?: CSSProperties;
} {
  const icon = providerClients.get(driverKind)?.icon;
  if (icon) {
    return {
      className: "text-(--icon-light) dark:text-(--icon-dark)",
      style: { "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties,
    };
  }
  return {};
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  size?: "default" | "compact";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const packageIcon = providerClients.get(props.driverKind)?.icon;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  const accentStyle = accentColor
    ? ({
        "--provider-accent": accentColor,
        "--provider-accent-foreground": providerAccentForegroundColor(accentColor),
      } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  const iconClassName = cn(props.size === "compact" && "size-3.5", props.iconClassName);

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={accentColor}
    >
      {packageIcon ? (
        <ProviderPackageIcon
          icon={packageIcon}
          className={cn("size-5 shrink-0", iconClassName)}
          aria-hidden
        />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-4xs font-semibold leading-none shadow-sm",
            accentColor
              ? "bg-(--provider-accent) text-(--provider-accent-foreground)"
              : "bg-card text-muted-foreground",
            props.size === "compact" &&
              "right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {badgeContent === "initials" ? providerInstanceInitials(props.displayName) : null}
        </span>
      ) : null}
    </span>
  );
});
