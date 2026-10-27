// Kernels map LOAD segments in whole pages. Checking at 64 KiB covers 4, 16, and 64 KiB kernels.
export function assertLinuxArm64PageCompatibility(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 64 ||
    view.getUint32(0, false) !== 0x7f454c46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    view.getUint16(18, true) !== 183
  ) {
    throw new Error("Expected a little-endian ELF64 ARM64 executable.");
  }
  const tableOffset = Number(view.getBigUint64(32, true));
  const entrySize = view.getUint16(54, true);
  const count = view.getUint16(56, true);
  if (
    !Number.isSafeInteger(tableOffset) ||
    entrySize < 56 ||
    count === 0 ||
    tableOffset + entrySize * count > bytes.length
  ) {
    throw new Error("Invalid ELF program header table.");
  }
  const pageSize = 0x10000n;
  const ranges: Array<{ start: bigint; end: bigint }> = [];
  for (let index = 0; index < count; index++) {
    const header = tableOffset + index * entrySize;
    if (view.getUint32(header, true) !== 1) continue;
    const offset = view.getBigUint64(header + 8, true);
    const address = view.getBigUint64(header + 16, true);
    const size = view.getBigUint64(header + 40, true);
    if (offset % pageSize !== address % pageSize) {
      throw new Error(`ARM64 LOAD segment ${index} is incompatible with 64 KiB pages.`);
    }
    if (size === 0n) continue;
    const start = address / pageSize;
    const end = (address + size + pageSize - 1n) / pageSize;
    if (ranges.some((range) => start < range.end && range.start < end)) {
      throw new Error(`ARM64 LOAD segments overlap on a 64 KiB page (segment ${index}).`);
    }
    ranges.push({ start, end });
  }
  if (ranges.length === 0) throw new Error("ELF executable has no LOAD segments.");
}
