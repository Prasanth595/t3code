import type { filePreviewKind } from "@t3tools/shared/filePreview";

export type OfficePreviewKind = Extract<ReturnType<typeof filePreviewKind>, "docx" | "xlsx">;
export const OFFICE_ARCHIVE_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});
function filenameCrc(bytes: Uint8Array) {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ -1) >>> 0;
}

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
  // JSZip's browser decoder tolerates overlong encodings. Reject those rather than
  // budgeting a replacement-character name that the renderer interprets as a path.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decodeName = (value: Uint8Array) => {
    try {
      return decoder.decode(value);
    } catch {
      return invalidOfficeArchive();
    }
  };
  let expanded = 0;
  let pos = directory;
  const inspectExtra = (start: number, length: number, rawName: Uint8Array) => {
    const stop = start + length;
    let unicodeName: Uint8Array | undefined;
    let seenUnicode = false;
    while (start < stop) {
      if (start + 4 > stop) return invalidOfficeArchive();
      const id = view.getUint16(start, true);
      const size = view.getUint16(start + 2, true);
      const next = start + 4 + size;
      if (next > stop) return invalidOfficeArchive();
      // ZIP64 changes the meaning of the 32-bit sizes and is outside the preview budget.
      if (id === 1) return invalidOfficeArchive();
      if (id === 0x7075) {
        if (seenUnicode || size < 1) return invalidOfficeArchive();
        seenUnicode = true;
        if (bytes[start + 4] === 1) {
          if (size < 5) return invalidOfficeArchive();
          if (view.getUint32(start + 5, true) === filenameCrc(rawName))
            unicodeName = bytes.subarray(start + 9, next);
        }
      }
      start = next;
    }
    return unicodeName;
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
    const unicodeName = inspectExtra(pos + 46 + nameLength, extraLength, rawName);
    // JSZip uses the central Unicode Path field only when the UTF-8 flag is clear.
    // Budget and deduplicate that effective name, including legacy-codepage ZIPs.
    const name = decodeName((flags & 0x800) === 0 && unicodeName ? unicodeName : rawName);
    if (
      !name ||
      names.has(name) ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("//") ||
      name.includes("\0") ||
      name.split("/").some((part) => part === "." || part === "..")
    )
      return invalidOfficeArchive();
    names.add(name);
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
    // JSZip skips local Unicode names; only the central directory can rename an entry.
    inspectExtra(local + 30 + nameLength, localExtra, rawName);
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
