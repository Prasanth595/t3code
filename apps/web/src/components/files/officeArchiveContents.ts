import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import { Inflate } from "fflate";
import {
  invalidOfficeArchive,
  validateOfficeArchive,
  OFFICE_ARCHIVE_MAX_EXPANDED_BYTES,
  type OfficePreviewKind,
} from "./officeArchive";

const WORD_MAX_XML_BYTES = 2 * 1024 * 1024;
const WORD_MAX_ELEMENTS = 12000;
const WORD_MAX_MEDIA_BYTES = 4 * 1024 * 1024;
const WORD_MAX_IMAGE_PIXELS = 16_000_000;
const complexWord = () => {
  throw new Error(
    "This Word document is too complex to preview. Save it to open it in another app.",
  );
};

/** Streaming inflation verifies actual sizes with bounded input chunks, in a disposable worker. */
export function validateOfficeArchiveContents(bytes: Uint8Array, kind: OfficePreviewKind) {
  const entries = validateOfficeArchive(bytes, kind);
  let total = 0;
  let xmlBytes = 0;
  let elements = 0;
  let mediaBytes = 0;
  let pixels = 0;
  for (const entry of entries) {
    let written = 0;
    const isWordXml =
      kind === "docx" && entry.name.startsWith("word/") && entry.name.endsWith(".xml");
    const isWordMedia = kind === "docx" && entry.name.startsWith("word/media/") && entry.size > 0;
    const isWordFont = kind === "docx" && entry.name.startsWith("word/fonts/");
    if (isWordXml && (xmlBytes += entry.size) > WORD_MAX_XML_BYTES) return complexWord();
    if ((isWordMedia || isWordFont) && (mediaBytes += entry.size) > WORD_MAX_MEDIA_BYTES)
      return complexWord();
    const capture = isWordXml || isWordMedia;
    const chunks: Uint8Array[] = [];
    const consume = (data: Uint8Array) => {
      written += data.length;
      total += data.length;
      if (written > entry.size || total > OFFICE_ARCHIVE_MAX_EXPANDED_BYTES)
        return invalidOfficeArchive();
      if (capture) chunks.push(data.slice());
    };
    if (entry.method === 0) consume(bytes.subarray(entry.start, entry.end));
    else {
      const inflater = new Inflate(consume);
      // A forged DEFLATE stream cannot produce an unbounded chunk before our counter runs.
      for (let pos = entry.start; pos < entry.end; pos += 256)
        inflater.push(bytes.subarray(pos, Math.min(pos + 256, entry.end)), pos + 256 >= entry.end);
      if (entry.start === entry.end) inflater.push(new Uint8Array(), true);
    }
    if (written !== entry.size) return invalidOfficeArchive();
    if (capture) {
      const content = new Uint8Array(written);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
      if (isWordXml) {
        const xml = new TextDecoder().decode(content);
        // Default Word catalogs contain thousands of unused styles; count renderable content.
        if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(entry.name)) {
          for (const _match of xml.matchAll(/<[A-Za-z_][^>]*>/g))
            if (++elements > WORD_MAX_ELEMENTS) return complexWord();
        }
      } else {
        const dimensions = readImageDimensions(content);
        if (!dimensions || (pixels += dimensions.width * dimensions.height) > WORD_MAX_IMAGE_PIXELS)
          return complexWord();
      }
    }
  }
}
