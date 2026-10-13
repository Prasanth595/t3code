import type { MachineKind } from "@t3tools/contracts/machineMap";

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Lucide shapes, as in the mockup. */
export function KindIcon({ kind }: { kind: MachineKind }) {
  switch (kind) {
    case "laptop":
      return (
        <svg viewBox="0 0 24 24" {...STROKE} aria-hidden>
          <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
        </svg>
      );
    case "server":
      return (
        <svg viewBox="0 0 24 24" {...STROKE} aria-hidden>
          <rect width="20" height="8" x="2" y="2" rx="2" />
          <rect width="20" height="8" x="2" y="14" rx="2" />
          <line x1="6" x2="6.01" y1="6" y2="6" />
          <line x1="6" x2="6.01" y1="18" y2="18" />
        </svg>
      );
    case "desktop":
      return (
        <svg viewBox="0 0 24 24" {...STROKE} aria-hidden>
          <rect width="20" height="14" x="2" y="3" rx="2" />
          <line x1="8" x2="16" y1="21" y2="21" />
          <line x1="12" x2="12" y1="17" y2="21" />
        </svg>
      );
  }
}

export function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" {...STROKE} strokeWidth={2.4} aria-hidden>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}
