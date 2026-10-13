/**
 * MM-708: the sounds and the one-shot effects of the big red button. Web Audio makes the sounds,
 * so the portal ships no audio files. The effects use the Web Animations API and remove themselves.
 */

let audio: AudioContext | undefined;

/** Browsers allow sound only after a user gesture. Every caller runs inside a click. */
function audioContext(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

interface Sweep {
  readonly wave: OscillatorType;
  readonly from: number;
  readonly to: number;
  /** Seconds after now. */
  readonly at: number;
  readonly length: number;
  readonly volume: number;
}

function play(sweeps: readonly Sweep[]): void {
  const context = audioContext();
  if (!context) return;
  const now = context.currentTime;
  for (const sweep of sweeps) {
    const start = now + sweep.at;
    const end = start + sweep.length;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = sweep.wave;
    oscillator.frequency.setValueAtTime(sweep.from, start);
    oscillator.frequency.exponentialRampToValueAtTime(sweep.to, end);
    gain.gain.setValueAtTime(sweep.volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end);
  }
}

/** A plastic click for the cover. */
export const playCoverSound = (open: boolean): void =>
  play([
    {
      wave: "square",
      from: open ? 1800 : 900,
      to: open ? 700 : 400,
      at: 0,
      length: 0.05,
      volume: 0.06,
    },
  ]);

/** A heavy thunk, three klaxon whoops, then a slide down as everything powers off. */
export const playPanicSound = (): void =>
  play([
    { wave: "sine", from: 170, to: 45, at: 0, length: 0.3, volume: 0.5 },
    ...[0, 1, 2].map((index) => ({
      wave: "sawtooth" as const,
      from: 380,
      to: 640,
      at: 0.15 + index * 0.38,
      length: 0.34,
      volume: 0.11,
    })),
    { wave: "triangle", from: 640, to: 90, at: 1.3, length: 0.8, volume: 0.2 },
  ]);

/** A short rising chime for Resume. */
export const playResumeSound = (): void =>
  play(
    [523, 659, 784, 1047].map((note, index) => ({
      wave: "sine" as const,
      from: note,
      to: note,
      at: index * 0.09,
      length: 0.25,
      volume: 0.18,
    })),
  );

/** A red flash over the page, a "STOPPED" stamp that slams down, and one shake of the page. */
export function showPanicEffects(): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const flash = document.createElement("div");
  flash.className = "panic-flash";
  document.body.append(flash);
  flash
    .animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 700, easing: "ease-out" })
    .finished.then(
      () => flash.remove(),
      () => flash.remove(),
    );

  if (reduceMotion) return;

  const stamp = document.createElement("div");
  stamp.className = "panic-stamp";
  const label = document.createElement("span");
  label.className = "stamp";
  label.textContent = "stopped";
  stamp.append(label);
  document.body.append(stamp);
  stamp
    .animate(
      [
        { opacity: 0, transform: "scale(3) rotate(-12deg)" },
        { opacity: 1, transform: "scale(1) rotate(-8deg)", offset: 0.15 },
        { opacity: 1, transform: "scale(1) rotate(-8deg)", offset: 0.75 },
        { opacity: 0, transform: "scale(1.05) rotate(-8deg)" },
      ],
      { duration: 1600, easing: "ease-out" },
    )
    .finished.then(
      () => stamp.remove(),
      () => stamp.remove(),
    );

  document
    .querySelector(".app")
    ?.animate(
      [
        { transform: "translate(0, 0)" },
        { transform: "translate(-10px, 4px)" },
        { transform: "translate(9px, -5px)" },
        { transform: "translate(-6px, 3px)" },
        { transform: "translate(4px, -2px)" },
        { transform: "translate(0, 0)" },
      ],
      { duration: 450, easing: "ease-out" },
    );
}
