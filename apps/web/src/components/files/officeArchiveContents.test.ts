import { Inflate, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { validateOfficeArchive, OFFICE_ARCHIVE_MAX_EXPANDED_BYTES } from "./officeArchive";
import { validateOfficeArchiveContents } from "./officeArchiveContents";

const observed = vi.hoisted(() => ({ inputs: [] as number[], outputs: [] as number[] }));
vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return {
    ...actual,
    Inflate: class extends actual.Inflate {
      constructor(consume: NonNullable<InstanceType<typeof actual.Inflate>["ondata"]>) {
        super((data, final) => {
          observed.outputs.push(data.length);
          consume(data, final);
        });
      }
      override push(data: Uint8Array, final?: boolean) {
        observed.inputs.push(data.length);
        super.push(data, final);
      }
    },
  };
});

function archive(size: number, level: 0 | 6 = 6) {
  return zipSync(
    {
      "[Content_Types].xml": new TextEncoder().encode("<Types/>"),
      "xl/workbook.xml": new Uint8Array(size),
    },
    { level },
  );
}

function forgeSize(bytes: Uint8Array, size: number) {
  const view = new DataView(bytes.buffer);
  let central = view.getUint32(bytes.length - 6, true);
  while (central < bytes.length - 22) {
    const local = view.getUint32(central + 42, true);
    if (view.getUint32(central + 24, true) > 100) {
      view.setUint32(central + 24, size, true);
      view.setUint32(local + 22, size, true);
    }
    central +=
      46 +
      view.getUint16(central + 28, true) +
      view.getUint16(central + 30, true) +
      view.getUint16(central + 32, true);
  }
}

describe("bounded archive inflation", () => {
  beforeEach(() => {
    observed.inputs.length = 0;
    observed.outputs.length = 0;
  });

  it("rejects a forged tiny size at the original small-chunk granularity", () => {
    const bytes = archive(8 * 1024 * 1024);
    forgeSize(bytes, 1);
    expect(() => validateOfficeArchiveContents(bytes, "xlsx")).toThrow("cannot be previewed");
    expect(Math.max(...observed.inputs)).toBeLessThanOrEqual(256);
    expect(Math.max(...observed.outputs)).toBeLessThan(300 * 1024);
  });

  it("bounds high-ratio expansion and rejects forged sizes near the aggregate limit", () => {
    const bytes = archive(80 * 1024 * 1024);
    forgeSize(bytes, OFFICE_ARCHIVE_MAX_EXPANDED_BYTES - 8);
    expect(() => validateOfficeArchive(bytes, "xlsx")).not.toThrow();
    expect(() => validateOfficeArchiveContents(bytes, "xlsx")).toThrow("cannot be previewed");
    expect(Math.max(...observed.inputs)).toBe(4096);
    expect(Math.max(...observed.outputs)).toBeLessThan(4 * 1024 * 1024 + 65536);
    expect(observed.outputs.reduce((sum, size) => sum + size, 0)).toBeLessThan(
      OFFICE_ARCHIVE_MAX_EXPANDED_BYTES + 300 * 1024,
    );
  });

  it.each([0, 6] as const)("accepts valid large stored/deflated content at level %s", (level) => {
    expect(() =>
      validateOfficeArchiveContents(archive(9 * 1024 * 1024, level), "xlsx"),
    ).not.toThrow();
  });

  it("handles stored DEFLATE blocks across chunk boundaries", () => {
    // A non-compressing DEFLATE stream still buffers a whole stored block.
    const bytes = archive(100000, 0);
    const entry = validateOfficeArchive(bytes, "xlsx").at(-1)!;
    const payload = bytes.subarray(entry.start, entry.end);
    const stream = new Uint8Array(payload.length + 10);
    const view = new DataView(stream.buffer);
    for (const [offset, length, final] of [
      [0, 65535, 0],
      [65540, 34465, 1],
    ]) {
      stream[offset!] = final!;
      view.setUint16(offset! + 1, length!, true);
      view.setUint16(offset! + 3, length! ^ 65535, true);
    }
    let written = 0;
    const inflate = new Inflate((data) => {
      written += data.length;
    });
    for (let pos = 0; pos < stream.length; pos += 4096)
      inflate.push(stream.subarray(pos, pos + 4096), pos + 4096 >= stream.length);
    expect(written).toBe(100000);
    expect(Math.max(...observed.outputs)).toBeLessThanOrEqual(65535);
  });
});
