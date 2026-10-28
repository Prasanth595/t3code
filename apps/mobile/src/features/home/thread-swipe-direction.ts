export function resolveThreadSwipeRelease(
  translation: number,
  side: "left" | "right",
  threshold: number,
  hasOppositeAction: boolean,
): "primary" | "opposite" | null {
  "worklet";
  const reveal = translation * (side === "left" ? 1 : -1);
  if (reveal >= threshold) return "primary";
  if (hasOppositeAction && -reveal >= threshold) return "opposite";
  return null;
}
