/**
 * MM-708, MM-212: the sounds and the one-shot effects of the big red button and of a join. Web
 * Audio makes the sounds, so the portal ships no audio files. The effects use the Web Animations
 * API and remove themselves.
 */

let audio: AudioContext | undefined;

/**
 * Browsers allow sound only after a user gesture. Every caller runs inside a click, except the
 * join sound of MM-212: it relies on the click that opened the join dialog. If a browser blocks
 * it, the join shows without sound.
 */
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

/** MM-212: two happy blips and a sparkle when a machine uses its join code. */
export const playJoinSound = (): void =>
  play([
    { wave: "triangle", from: 660, to: 990, at: 0, length: 0.12, volume: 0.2 },
    { wave: "triangle", from: 880, to: 1320, at: 0.13, length: 0.14, volume: 0.2 },
    { wave: "sine", from: 1760, to: 2093, at: 0.3, length: 0.35, volume: 0.1 },
  ]);

const CONFETTI = ["var(--accent)", "var(--green)", "var(--stamp)", "var(--panic)"];

/**
 * MM-212: the code card pops, a "joined" stamp lands on it, and confetti bursts out of it once.
 * With reduced motion the page shows the joined state and plays the sound only.
 */
export function showJoinEffects(card: HTMLElement): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  card.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.08) rotate(-1deg)" },
      { transform: "scale(1)" },
    ],
    { duration: 350, easing: "ease-out" },
  );
  const stamp = card.querySelector<HTMLElement>(".join-stamp");
  stamp?.animate(
    [
      { opacity: 0, transform: "translate(-50%, -50%) scale(2.5) rotate(-14deg)" },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1) rotate(-8deg)" },
    ],
    { duration: 300, easing: "ease-out", delay: 120, fill: "backwards" },
  );
  for (let index = 0; index < 18; index++) {
    const bit = document.createElement("span");
    bit.className = "confetti";
    bit.style.background = CONFETTI[index % CONFETTI.length] ?? "var(--accent)";
    card.append(bit);
    const angle = (index / 18) * Math.PI * 2;
    const distance = 70 + (index % 3) * 30;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    bit
      .animate(
        [
          { opacity: 1, transform: "translate(0, 0) rotate(0deg)" },
          {
            opacity: 1,
            transform: `translate(${x}px, ${y}px) rotate(${index * 30}deg)`,
            offset: 0.6,
          },
          { opacity: 0, transform: `translate(${x}px, ${y + 40}px) rotate(${index * 40}deg)` },
        ],
        { duration: 1200, easing: "cubic-bezier(0.2, 0.8, 0.4, 1)" },
      )
      .finished.then(
        () => bit.remove(),
        () => bit.remove(),
      );
  }
}

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
