import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import * as JpegJs from "jpeg-js";
import { PNG } from "pngjs";

/**
 * Anthropic rejects every image over 2000px on a side once a request holds
 * more than 20 images, and the whole conversation carries the bad image from
 * then on. Claude Code scales the images of a message that starts a turn, but
 * not those of a message that steers a running turn, so T3 fits those itself.
 * Decoding runs on the server's event loop: about 0.4s for a Retina
 * screenshot, up to about 1.7s for a 12MP photo.
 */
const CLAUDE_MAX_IMAGE_EDGE = 2000;

// About 100MB of decoded RGBA. Covers 6K screenshots and 24MP photos; bigger
// images pass through unchanged rather than risk exhausting the server.
const MAX_DECODE_PIXELS = 25_000_000;

const JPEG_QUALITY = 90;

/**
 * Returns image bytes Claude accepts in a many-image request: PNG and JPEG
 * over 2000px on a side are scaled down and re-encoded in the same format.
 * Everything else, including GIF, WebP, and images that fail to decode, is
 * returned unchanged.
 */
export const fitClaudeImage = (bytes: Uint8Array, mimeType: string) => {
  const dimensions = readImageDimensions(bytes);
  if (
    dimensions === null ||
    Math.max(dimensions.width, dimensions.height) <= CLAUDE_MAX_IMAGE_EDGE ||
    dimensions.width * dimensions.height > MAX_DECODE_PIXELS ||
    (mimeType !== "image/png" && mimeType !== "image/jpeg")
  ) {
    return Effect.succeed(bytes);
  }
  return Effect.try(() => (mimeType === "image/png" ? fitPng(bytes) : fitJpeg(bytes))).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not scale a Claude image attachment; sending it unchanged", {
        mimeType,
        cause,
      }).pipe(Effect.as(bytes)),
    ),
  );
};

function fitPng(bytes: Uint8Array): Uint8Array {
  const source = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const target = targetSize(source.width, source.height);
  const output = new PNG({ ...target, colorType: source.alpha ? 6 : 2 });
  downscale(source.data, source.width, source.height, output.data, target.width, target.height);
  return PNG.sync.write(output, { colorType: source.alpha ? 6 : 2 });
}

function fitJpeg(bytes: Uint8Array): Uint8Array {
  // jpeg-js reads and writes the EXIF block at runtime, but its types omit it.
  // Keeping it preserves a phone photo's orientation.
  const source: JpegJs.RawImageData<Uint8Array> & { readonly exifBuffer?: Uint8Array } =
    JpegJs.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_DECODE_PIXELS / 1_000_000,
    });
  const target = targetSize(source.width, source.height);
  const data = new Uint8Array(target.width * target.height * 4);
  downscale(source.data, source.width, source.height, data, target.width, target.height);
  const raw = { ...target, data, exifBuffer: source.exifBuffer };
  return JpegJs.encode(raw, JPEG_QUALITY).data;
}

function targetSize(width: number, height: number) {
  const scale = CLAUDE_MAX_IMAGE_EDGE / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// Box filter over RGBA. Color is weighted by alpha so transparent pixels do
// not darken the opaque pixels they are averaged with.
function downscale(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  target: Uint8Array,
  targetWidth: number,
  targetHeight: number,
) {
  for (let ty = 0; ty < targetHeight; ty++) {
    const y0 = Math.floor((ty * sourceHeight) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sourceHeight) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx++) {
      const x0 = Math.floor((tx * sourceWidth) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sourceWidth) / targetWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sourceWidth + x) * 4;
          const alpha = source[i + 3]!;
          r += source[i]! * alpha;
          g += source[i + 1]! * alpha;
          b += source[i + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (ty * targetWidth + tx) * 4;
      if (a > 0) {
        target[o] = Math.round(r / a);
        target[o + 1] = Math.round(g / a);
        target[o + 2] = Math.round(b / a);
      }
      target[o + 3] = Math.round(a / ((y1 - y0) * (x1 - x0)));
    }
  }
}
