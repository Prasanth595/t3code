import type { filePreviewKind } from "@t3tools/shared/filePreview";

export type OfficePreviewKind = Extract<ReturnType<typeof filePreviewKind>, "docx" | "xlsx">;
export const OFFICE_ARCHIVE_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;

export function invalidOfficeArchive(): never {
  throw new Error(
    "This file cannot be previewed. It may be damaged, encrypted, or use an unsupported Office format. Save it to open it in another app.",
  );
}

/** Inspect both ZIP directories before an inflater can trust a size or offset. */
export function validateOfficeArchive(bytes: Uint8Array, kind: OfficePreviewKind) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // SheetJS selects the last end-marker even in a ZIP comment; validate that same marker.
  for (let pos = bytes.length - 4; pos >= Math.max(0, bytes.length - 65557); pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      if (pos + 22 > bytes.length || pos + 22 + view.getUint16(pos + 20, true) !== bytes.length)
        return invalidOfficeArchive();
      end = pos;
      break;
    }
  }
  if (end < 0) return invalidOfficeArchive();
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directory = view.getUint32(end + 16, true);
  if (
    !count ||
    count > 10000 ||
    view.getUint32(end + 4, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    directory + directorySize !== end
  )
    return invalidOfficeArchive();
  const entries: {
    name: string;
    method: number;
    start: number;
    end: number;
    size: number;
    localStart: number;
    localEnd: number;
  }[] = [];
  const names = new Set<string>();
  const decoder = new TextDecoder();
  let expanded = 0;
  let pos = directory;
  const inspectExtra = (start: number, length: number) => {
    const stop = start + length;
    while (start < stop) {
      if (start + 4 > stop) return invalidOfficeArchive();
      // ZIP64 changes the meaning of the 32-bit sizes and is outside the preview budget.
      if (view.getUint16(start, true) === 1) return invalidOfficeArchive();
      start += 4 + view.getUint16(start + 2, true);
      if (start > stop) return invalidOfficeArchive();
    }
  };
  for (let index = 0; index < count; index++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) return invalidOfficeArchive();
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressed = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const next = pos + 46 + nameLength + extraLength + view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    if (
      (flags & ~0x080e) !== 0 ||
      (method !== 0 && method !== 8) ||
      view.getUint16(pos + 34, true) !== 0 ||
      next > end ||
      local + 30 > directory
    )
      return invalidOfficeArchive();
    expanded += size;
    if (expanded > OFFICE_ARCHIVE_MAX_EXPANDED_BYTES)
      throw new Error("This document is too large to preview. Save it to open it in another app.");
    const rawName = bytes.subarray(pos + 46, pos + 46 + nameLength);
    const name = decoder.decode(rawName);
    if (
      !name ||
      names.has(name) ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => part === "." || part === "..")
    )
      return invalidOfficeArchive();
    names.add(name);
    inspectExtra(pos + 46 + nameLength, extraLength);
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 26, true) !== nameLength
    )
      return invalidOfficeArchive();
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + nameLength + localExtra;
    const dataEnd = start + compressed;
    if (dataEnd > directory || (method === 0 && compressed !== size)) return invalidOfficeArchive();
    for (let n = 0; n < nameLength; n++)
      if (bytes[local + 30 + n] !== rawName[n]) return invalidOfficeArchive();
    inspectExtra(local + 30 + nameLength, localExtra);
    const descriptor = (flags & 8) !== 0;
    for (const [offset, expected] of [
      [14, crc],
      [18, compressed],
      [22, size],
    ] as const) {
      const actual = view.getUint32(local + offset, true);
      if (actual !== expected && !(descriptor && actual === 0)) return invalidOfficeArchive();
    }
    let localEnd = dataEnd;
    if (descriptor) {
      if (localEnd + 12 > directory) return invalidOfficeArchive();
      if (view.getUint32(localEnd, true) === 0x08074b50) localEnd += 4;
      if (
        localEnd + 12 > directory ||
        view.getUint32(localEnd, true) !== crc ||
        view.getUint32(localEnd + 4, true) !== compressed ||
        view.getUint32(localEnd + 8, true) !== size
      )
        return invalidOfficeArchive();
      localEnd += 12;
    }
    entries.push({ name, method, start, end: dataEnd, size, localStart: local, localEnd });
    pos = next;
  }
  if (
    pos !== end ||
    !names.has("[Content_Types].xml") ||
    !names.has(kind === "docx" ? "word/document.xml" : "xl/workbook.xml")
  )
    return invalidOfficeArchive();
  const byOffset = entries.toSorted((a, b) => a.localStart - b.localStart);
  for (let index = 1; index < byOffset.length; index++)
    if (byOffset[index]!.localStart < byOffset[index - 1]!.localEnd) return invalidOfficeArchive();
  return entries;
}
