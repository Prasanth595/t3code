import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const contextChipVariants = cva(
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.4em] px-[0.2em] align-middle font-medium text-[0.86em] text-(--context-chip-accent) leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none [button:enabled&,a&]:hover:bg-(--context-chip-accent)/12 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground disabled:cursor-default",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral: "[--context-chip-accent:currentColor]",
        image: "[--context-chip-accent:var(--context-chip-image)]",
        video: "[--context-chip-accent:var(--context-chip-video)]",
        file: "[--context-chip-accent:var(--context-chip-file)]",
        mention: "[--context-chip-accent:var(--context-chip-mention)]",
        terminal: "[--context-chip-accent:var(--context-chip-terminal)]",
        element: "[--context-chip-accent:var(--context-chip-element)]",
        "preview-annotation": "[--context-chip-accent:var(--context-chip-preview-annotation)]",
        "review-comment": "[--context-chip-accent:var(--context-chip-review-comment)]",
        "pull-request": "[--context-chip-accent:var(--context-chip-pull-request)]",
        "pr-open": "[--context-chip-accent:var(--context-chip-pr-open)]",
        "pr-draft": "[--context-chip-accent:var(--context-chip-pr-draft)]",
        "pr-merged": "[--context-chip-accent:var(--context-chip-pr-merged)]",
        "pr-closed": "[--context-chip-accent:var(--context-chip-pr-closed)]",
        skill: "[--context-chip-accent:var(--context-chip-skill)]",
        thread: "[--context-chip-accent:var(--context-chip-thread)]",
        citation: "[--context-chip-accent:var(--context-chip-citation)]",
      },
      state: {
        unresolved: "data-[state=unresolved]:[--context-chip-accent:currentColor]",
        invalid:
          "data-[state=invalid]:[--context-chip-accent:var(--context-chip-invalid,var(--destructive-foreground))]",
      },
    },
  },
);

type ContextChipKind = NonNullable<VariantProps<typeof contextChipVariants>["kind"]>;

interface ContextChipProps extends useRender.ComponentProps<"span"> {
  kind?: ContextChipKind;
  state?: "unresolved" | "invalid";
}

function ContextChip({ className, kind, state, render, ...props }: ContextChipProps) {
  const defaultProps = {
    className: cn(contextChipVariants({ kind, state }), className),
    "data-slot": "context-chip",
    "data-state": state,
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

function ContextChipLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("block min-w-0 self-center truncate leading-tight", className)}
      data-slot="context-chip-label"
      {...props}
    />
  );
}

function ContextChipAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  const defaultProps = {
    className: cn(
      "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-current transition-colors hover:bg-(--context-chip-accent,var(--color-foreground))/17 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-[0.85em]",
      className,
    ),
    "data-slot": "context-chip-action",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { ContextChip, ContextChipAction, ContextChipLabel, type ContextChipKind };
