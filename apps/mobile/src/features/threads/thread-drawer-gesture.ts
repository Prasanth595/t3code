export type ThreadDrawerSide = "left" | "right";

export function drawerDragProgress(
  side: ThreadDrawerSide,
  translation: number,
  width: number,
  open: boolean,
): number {
  "worklet";
  const direction = side === "left" ? 1 : -1;
  return Math.min(1, Math.max(0, Number(open) + (direction * translation) / width));
}

export function drawerShouldOpen(
  side: ThreadDrawerSide,
  translation: number,
  velocity: number,
  width: number,
  open: boolean,
): boolean {
  "worklet";
  const direction = (side === "left" ? 1 : -1) * (open ? -1 : 1);
  const committed = direction * translation > width * 0.35 || direction * velocity > 500;
  return open ? !committed : committed;
}
