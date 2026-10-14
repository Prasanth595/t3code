import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import { Inflate } from "fflate";
import { SaxesParser } from "saxes";
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
const INFLATE_CHUNK_BYTES = 4096;
const DEFLATE_MAX_EXPANSION_RATIO = 1032;
const WORD_XML_RELATIONSHIPS = new Set([
  "officeDocument",
  "fontTable",
  "numbering",
  "styles",
  "theme",
  "footnotes",
  "endnotes",
  "footer",
  "header",
  "core-properties",
  "extended-properties",
  "custom-properties",
  "settings",
  "comments",
  "commentsExtended",
]);
const WORD_CONTENT_RELATIONSHIPS = new Set([
  "officeDocument",
  "footnotes",
  "endnotes",
  "footer",
  "header",
  "comments",
]);
const complexWord = () => {
  throw new Error(
    "This Word document is too complex to preview. Save it to open it in another app.",
  );
};

/** Streaming inflation verifies actual sizes with bounded input chunks, in a disposable worker. */
export function validateOfficeArchiveContents(bytes: Uint8Array, kind: OfficePreviewKind) {
  const entries = validateOfficeArchive(bytes, kind);
  let total = 0;
  const inflate = (entry: (typeof entries)[number], capture: boolean) => {
    let written = 0;
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
      // Larger pushes avoid copying the 32 KiB history on every 256 input bytes.
      // DEFLATE emits at most 258 bytes per length/distance pair (at least two bits).
      // A 4 KiB push therefore emits about 4 MiB at worst, independently of forged
      // headers. Near the declared budget retain the smaller rejection granularity.
      for (let pos = entry.start; pos < entry.end;) {
        const remaining = Math.min(entry.size - written, OFFICE_ARCHIVE_MAX_EXPANDED_BYTES - total);
        const chunk = Math.min(
          INFLATE_CHUNK_BYTES,
          Math.max(256, Math.floor(remaining / DEFLATE_MAX_EXPANSION_RATIO)),
        );
        const end = Math.min(pos + chunk, entry.end);
        inflater.push(bytes.subarray(pos, end), end === entry.end);
        pos = end;
      }
      if (entry.start === entry.end) inflater.push(new Uint8Array(), true);
    }
    if (written !== entry.size) return invalidOfficeArchive();
    if (!capture) return new Uint8Array();
    const content = new Uint8Array(written);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    return content;
  };

  const xmlParts = new Set<string>();
  const contentParts = new Set<string>();
  const imageParts = new Set<string>();
  const fontParts = new Set<string>();
  const relationships = new Map<string, Uint8Array>();
  let relationshipBytes = 0;
  // Relationships choose parser roles independently of filenames. Resolve every
  // role first, including relationships that refer to another .rels file.
  if (kind === "docx") {
    for (const entry of entries) {
      if (!entry.name.endsWith(".rels")) continue;
      if ((relationshipBytes += entry.size) > WORD_MAX_XML_BYTES) return complexWord();
      const content = inflate(entry, true);
      relationships.set(entry.name, content);
      const sax = new SaxesParser({ xmlns: true });
      sax.on("doctype", invalidOfficeArchive);
      sax.on("opentag", (tag) => {
        const attr = (name: string) =>
          Object.values(tag.attributes).find((a) => a.local === name)?.value;
        const target = attr("Target");
        const type = attr("Type")?.split("/").at(-1);
        if (!target || !type) return;
        const folder = entry.name.includes("/_rels/")
          ? entry.name.slice(0, entry.name.lastIndexOf("/_rels/") + 1)
          : "";
        // Match docx-preview's root targets and URL-based relative resolution.
        let path = target;
        if (entry.name !== "_rels/.rels") {
          try {
            path = new URL(target, `http://docx/${folder}`).toString().slice("http://docx/".length);
          } catch {
            path = folder + target;
          }
        }
        path = path.replace(/^\//, "");
        if (WORD_XML_RELATIONSHIPS.has(type)) xmlParts.add(path);
        if (WORD_CONTENT_RELATIONSHIPS.has(type)) contentParts.add(path);
        if (type === "image") imageParts.add(path);
        if (type === "font") fontParts.add(path);
      });
      sax.write(new TextDecoder().decode(content)).close();
    }
  }

  let xmlBytes = 0;
  let elements = 0;
  let mediaBytes = 0;
  let pixels = 0;
  for (const entry of entries) {
    const isWordXml =
      kind === "docx" &&
      (entry.name.endsWith(".xml") || relationships.has(entry.name) || xmlParts.has(entry.name));
    const isWordMedia =
      kind === "docx" &&
      (entry.name.startsWith("word/media/") || imageParts.has(entry.name)) &&
      entry.size > 0;
    const isWordFont =
      kind === "docx" && (entry.name.startsWith("word/fonts/") || fontParts.has(entry.name));
    if (isWordXml && (xmlBytes += entry.size) > WORD_MAX_XML_BYTES) return complexWord();
    if ((isWordMedia || isWordFont) && (mediaBytes += entry.size) > WORD_MAX_MEDIA_BYTES)
      return complexWord();
    const content = relationships.get(entry.name) ?? inflate(entry, isWordXml || isWordMedia);
    if (isWordXml) {
      const renderable =
        contentParts.has(entry.name) ||
        /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(entry.name);
      // Default style catalogs contain thousands of unused styles; only parts
      // that can supply document content consume the element budget.
      if (renderable) {
        const sax = new SaxesParser({ xmlns: true });
        sax.on("doctype", invalidOfficeArchive);
        sax.on("opentag", () => {
          if (++elements > WORD_MAX_ELEMENTS) return complexWord();
        });
        sax.write(new TextDecoder().decode(content)).close();
      }
    }
    if (isWordMedia) {
      const dimensions = readImageDimensions(content);
      if (!dimensions || (pixels += dimensions.width * dimensions.height) > WORD_MAX_IMAGE_PIXELS)
        return complexWord();
    }
  }
}
