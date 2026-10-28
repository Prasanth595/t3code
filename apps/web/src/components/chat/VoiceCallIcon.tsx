import type { VoiceCall } from "@t3tools/client-runtime/voice-call";

import type { VoiceCallSession } from "~/state/voiceCallSession";
import { cn } from "~/lib/utils";

const BARS = [
  { x: 3, half: 2 },
  { x: 7.5, half: 6 },
  { x: 12, half: 9 },
  { x: 16.5, half: 5 },
  { x: 21, half: 2 },
];
// A bar never shrinks below this share of its height, so a quiet call still reads as a wave.
const REST_SCALE = 0.35;

/**
 * The call's wave: each bar follows the live loudness of one voice band, from the call's own
 * microphone and the answering voice. Bars are drawn straight from the level stream, not through
 * React state, and the icon pulses while the call connects. Without a call it is a still wave.
 */
export function VoiceCallIcon({
  call,
  className,
}: {
  call?: VoiceCallSession | null | undefined;
  className?: string;
}) {
  const connecting = call?.state.phase === "connecting";
  const levels: VoiceCall["levels"] | undefined = call?.call.levels;
  const followLevels = (svg: SVGSVGElement | null) => {
    if (svg === null || levels === undefined) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lines = Array.from(svg.querySelectorAll("line"));
    const draw = (bands: ReadonlyArray<number>) =>
      lines.forEach((line, bar) => {
        line.style.scale = `1 ${REST_SCALE + (1 - REST_SCALE) * (bands[bar] ?? 0)}`;
      });
    draw(levels.current());
    return levels.subscribe(draw);
  };
  return (
    <svg
      ref={followLevels}
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className={cn(
        className,
        // Reduced motion keeps the bars still and shows a talking call by brightness instead.
        "motion-reduce:opacity-60",
        call?.state.speaking && "motion-reduce:opacity-100",
        connecting && "animate-pulse motion-reduce:animate-none",
      )}
    >
      {BARS.map(({ x, half }) => (
        <line
          key={x}
          x1={x}
          x2={x}
          y1={12 - half}
          y2={12 + half}
          className="origin-center [transform-box:fill-box]"
        />
      ))}
    </svg>
  );
}
