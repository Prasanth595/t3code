// @effect-diagnostics globalTimers:off - The analyser is polled on a bounded browser interval.
/** Loudness from 0 to 1 in each voice band, lowest pitch first. */
export type AudioBands = ReadonlyArray<number>;

const AUDIO_BAND_COUNT = 5;
export const SILENCE: AudioBands = Array.from({ length: AUDIO_BAND_COUNT }, () => 0);

const AUDIO_POLL_MS = 80;
// Bins of a 64-point analyser at 48 kHz are 750 Hz wide: the voice sits in the first dozen.
const AUDIO_FIRST_BIN = 1;
const BINS_PER_BAND = 2;
// Quiet room noise sits below the floor; ordinary speech reaches the ceiling.
const AUDIO_FLOOR = 0.1;
const AUDIO_CEILING = 0.6;
// How quickly a band falls back after a peak, per poll.
const AUDIO_DECAY = 0.7;
// Smaller moves are not worth waking every icon for.
const AUDIO_MIN_CHANGE = 0.04;
/** A band at this level or above counts as someone talking. */
export const SPEAKING_LEVEL = 0.15;

/** Reports the stream's loudness per voice band while it changes; returns a disposer. */
export const watchAudio = (stream: MediaStream, onBands: (bands: AudioBands) => void) => {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.5;
  context.createMediaStreamSource(stream).connect(analyser);
  const spectrum = new Uint8Array(analyser.frequencyBinCount);
  let sent = SILENCE;
  let shown = SILENCE;
  const timer = setInterval(() => {
    analyser.getByteFrequencyData(spectrum);
    shown = shown.map((previous, band) => {
      const start = AUDIO_FIRST_BIN + band * BINS_PER_BAND;
      const bins = spectrum.subarray(start, start + BINS_PER_BAND);
      const heard = bins.reduce((sum, bin) => sum + bin, 0) / bins.length / 255;
      const level = Math.min(1, Math.max(0, (heard - AUDIO_FLOOR) / (AUDIO_CEILING - AUDIO_FLOOR)));
      return Math.max(level, previous * AUDIO_DECAY);
    });
    const moved = shown.some((level, band) => Math.abs(level - sent[band]!) >= AUDIO_MIN_CHANGE);
    // Settling to silence always goes out, so a resting icon never hangs mid-wave.
    const settled = shown.every((level) => level < 0.01) && sent.some((level) => level >= 0.01);
    if (!moved && !settled) return;
    onBands((sent = shown));
  }, AUDIO_POLL_MS);
  return () => {
    clearInterval(timer);
    void context.close();
  };
};
