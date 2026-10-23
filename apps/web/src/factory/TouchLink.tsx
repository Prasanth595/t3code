import type { ComponentProps } from "react";

import { InlineButton } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/**
 * An inline link that is a 44 px tap target on a phone. Only `Button` has a coarse-pointer hit
 * area of its own; `InlineButton` is text-high, so the height is a layout class here, once.
 */
export function TouchLink({ className, ...props }: ComponentProps<typeof InlineButton>) {
  return <InlineButton className={cn("min-h-11", className)} {...props} />;
}
