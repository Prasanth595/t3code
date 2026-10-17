/**
 * Browsers paint a multipart/x-mixed-replace part only after the next part begins, and the hub
 * writes a frame only when the screen changes. Without help, an `<img>` viewer shows nothing
 * for a still screen and always hides the last frame of a change. Clients that view MJPEG, such
 * as the iOS app, then time out waiting for the first frame.
 */
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export const STILL_FRAME_DELAY = Duration.millis(100);

const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 16 * 1024;

type Part = Arr.NonEmptyReadonlyArray<Uint8Array>;

const endsWithCrlf = (part: Part) => {
  const tail = Buffer.concat(part.slice(-2)).subarray(-2);
  return tail[0] === 0x0d && tail[1] === 0x0a;
};

/**
 * Follows the hub's part framing (`--boundary`, headers with Content-Length, body, CRLF) and
 * keeps the last complete part as views into the forwarded chunks, so frames are never copied.
 * Any other framing turns it off and the stream passes through untouched.
 */
const partTracker = () => {
  let pieces: Array<Uint8Array> = [];
  let size = 0;
  let partEnd: number | null = null;
  let recognized = true;
  return (chunk: Uint8Array): { readonly atBoundary: boolean; readonly part?: Part } => {
    if (!recognized) return { atBoundary: false };
    let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let part: Part | undefined;
    while (rest.length > 0) {
      if (partEnd === null) {
        const head = size === 0 ? rest : Buffer.concat([...pieces, rest]);
        const headerEnd = head.indexOf(HEADER_END);
        if (headerEnd < 0) {
          if (head.length > MAX_HEADER_BYTES) recognized = false;
          pieces.push(rest);
          size += rest.length;
          break;
        }
        const headers = head.subarray(0, headerEnd).toString("latin1");
        const length = /^content-length:\s*(\d+)\s*$/im.exec(headers)?.[1];
        if (!headers.startsWith("--") || length === undefined) {
          recognized = false;
          break;
        }
        partEnd = headerEnd + HEADER_END.length + Number(length) + 2;
      }
      const taken = rest.subarray(0, partEnd - size);
      pieces.push(taken);
      size += taken.length;
      rest = rest.subarray(taken.length);
      if (size < partEnd) break;
      const complete = pieces;
      if (!Arr.isArrayNonEmpty(complete) || !endsWithCrlf(complete)) {
        recognized = false;
        break;
      }
      part = complete;
      pieces = [];
      size = 0;
      partEnd = null;
    }
    if (!recognized) pieces = [];
    return { atBoundary: recognized && size === 0, ...(part ? { part } : {}) };
  };
};

/** Re-sends the latest frame once when the stream goes quiet between frames. */
export const repeatStillFrame = <E, R>(body: Stream.Stream<Uint8Array, E, R>) =>
  Stream.transformPull(body, (pull, scope) =>
    Effect.sync(() => {
      const track = partTracker();
      let pending: Fiber.Fiber<Effect.Success<typeof pull>, Effect.Error<typeof pull>> | null =
        null;
      let still: Part | null = null;
      const forward = (chunks: Effect.Success<typeof pull>) => {
        pending = null;
        for (const chunk of chunks) {
          const { atBoundary, part } = track(chunk);
          if (!atBoundary) still = null;
          else if (part) still = part;
        }
        return chunks;
      };
      return Effect.gen(function* () {
        pending ??= yield* Effect.forkIn(pull, scope);
        if (still) {
          const repeat = still;
          // Timing out the join leaves the pull running, so the next frame is never lost.
          const next = yield* Fiber.join(pending).pipe(Effect.timeoutOption(STILL_FRAME_DELAY));
          if (Option.isSome(next)) return forward(next.value);
          still = null;
          return repeat;
        }
        return forward(yield* Fiber.join(pending));
      });
    }),
  );
