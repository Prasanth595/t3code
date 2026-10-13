import type { filePreviewKind } from "@t3tools/shared/filePreview";

export type OfficePreviewKind = Extract<ReturnType<typeof filePreviewKind>, "docx" | "xlsx">;

/** Check the ZIP directory before a renderer expands XML, images or shared strings. */
export function validateOfficeArchive(bytes: Uint8Array, kind: OfficePreviewKind) {
  const fail = () => {
    throw new Error(
      "This file cannot be previewed. It may be damaged, encrypted, or use an unsupported Office format. Save it to open it in another app.",
    );
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) return fail();
  const entries = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (
    entries === 0 ||
    entries > 10000 ||
    offset + size > end ||
    view.getUint32(end + 4, true) !== 0
  )
    return fail();
  let expanded = 0;
  let hasDocument = false;
  let hasContentTypes = false;
  const requiredPart = kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) return fail();
    if ((view.getUint16(offset + 8, true) & 1) !== 0) return fail();
    expanded += view.getUint32(offset + 24, true);
    if (expanded > 64 * 1024 * 1024)
      throw new Error("This document is too large to preview. Save it to open it in another app.");
    const nameLength = view.getUint16(offset + 28, true);
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (next > end) return fail();
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    hasDocument ||= name === requiredPart;
    hasContentTypes ||= name === "[Content_Types].xml";
    offset = next;
  }
  if (!hasDocument || !hasContentTypes) return fail();
}
