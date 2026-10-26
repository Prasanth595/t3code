import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

/** Text past this point is dropped; the model's context and the bill both stay bounded. */
export const MAX_DOCUMENT_TEXT_CHARS = 120_000;

export type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx" | "text";

const EXTENSION_KINDS: Readonly<Record<string, DocumentKind>> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  txt: "text",
  md: "text",
  csv: "text",
  json: "text",
};

/** The kind of document a file is, by extension; none for formats Mira cannot read. */
export const documentKind = (fileName: string): DocumentKind | undefined => {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_KINDS[extension];
};

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeXml = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name] ?? entity;
  });

/** Text runs of an Office XML part, with a line break after each paragraph. */
const xmlText = (xml: string, runTag: string, paragraphTag: string) => {
  const pattern = new RegExp(`<${runTag}(?:\\s[^>]*)?>([^<]*)</${runTag}>|</${paragraphTag}>`, "g");
  let text = "";
  for (const match of xml.matchAll(pattern)) text += match[1] ?? "\n";
  return text;
};

const naturalOrder = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true });

const partsMatching = (files: Record<string, Uint8Array>, pattern: RegExp) =>
  Object.keys(files)
    .filter((name) => pattern.test(name))
    .sort(naturalOrder);

const docxText = (files: Record<string, Uint8Array>) => {
  const document = files["word/document.xml"];
  return document ? decodeXml(xmlText(strFromU8(document), "w:t", "w:p")) : "";
};

const pptxText = (files: Record<string, Uint8Array>) =>
  partsMatching(files, /^ppt\/slides\/slide\d+\.xml$/)
    .map((name, index) => {
      const text = decodeXml(xmlText(strFromU8(files[name]!), "a:t", "a:p")).trim();
      return `Slide ${index + 1}\n${text}`;
    })
    .join("\n\n");

const xlsxText = (files: Record<string, Uint8Array>) => {
  const shared = files["xl/sharedStrings.xml"];
  const strings = shared
    ? [...strFromU8(shared).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
        decodeXml((match[1] ?? "").replace(/<[^>]*>/g, "")),
      )
    : [];
  return partsMatching(files, /^xl\/worksheets\/sheet\d+\.xml$/)
    .map((name, index) => {
      const rows = [...strFromU8(files[name]!).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(
        (row) =>
          [...(row[1] ?? "").matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map(([, attributes = "", body = ""]) => {
              const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
              const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
              if (/t="s"/.test(attributes) && value !== undefined) {
                return strings[Number(value)] ?? "";
              }
              if (inline !== undefined) return decodeXml(inline.replace(/<[^>]*>/g, ""));
              return value === undefined ? "" : decodeXml(value);
            })
            .join(","),
      );
      return `Sheet ${index + 1}\n${rows.join("\n")}`;
    })
    .join("\n\n");
};

const pdfText = async (bytes: Uint8Array) => {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((page, index) => `Page ${index + 1}\n${page}`).join("\n\n");
};

/** The readable text of a document, cut to `MAX_DOCUMENT_TEXT_CHARS`. */
export const extractDocumentText = async (kind: DocumentKind, bytes: Uint8Array) => {
  const text =
    kind === "pdf"
      ? await pdfText(bytes)
      : kind === "text"
        ? new TextDecoder().decode(bytes)
        : kind === "docx"
          ? docxText(unzipSync(bytes))
          : kind === "pptx"
            ? pptxText(unzipSync(bytes))
            : xlsxText(unzipSync(bytes));
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  return trimmed.length > MAX_DOCUMENT_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\n[The rest of this document was cut off.]`
    : trimmed;
};
