import type { SelectedFields } from "@t3tools/provider-core/server/usage";
import type { TranscriptParsePosition } from "./usageTranscriptReader.ts";

export interface ProjectionRequest {
  readonly filePath: string;
  readonly markers: readonly [string, ...string[]];
  readonly fields: SelectedFields;
  readonly lineLimit: number;
  readonly readBufferBytes: number;
  readonly guardBytes: number;
}

export type ProjectionReply =
  | {
      readonly kind: "parsed";
      readonly records: readonly unknown[];
      readonly tailRecords: readonly unknown[];
      readonly position: Omit<TranscriptParsePosition, "state">;
    }
  | { readonly kind: "fallback" }
  | { readonly kind: "unreadable" };

// This function is embedded as worker source. Keep runtime dependencies inside
// it and use only built-ins, so the same code runs in npm, Electron and SEA.
function projectionWorker() {
  const port = process.getBuiltinModule("worker_threads").parentPort;
  const fs = process.getBuiltinModule("fs").promises;
  if (port === null) return;

  function project(value: unknown, fields: SelectedFields | true): unknown {
    if (fields === true || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return [];
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const selected = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (selected !== undefined) result[key] = project(child, selected);
    }
    return result;
  }

  async function read(request: ProjectionRequest): Promise<ProjectionReply> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(request.filePath, "r");
      const marker = request.markers.length === 1 ? Buffer.from(request.markers[0]) : null;
      const pattern = new RegExp(
        request.markers.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      );
      const records: unknown[] = [];
      const tailRecords: unknown[] = [];
      const parse = (line: Buffer, out: unknown[]) => {
        if (marker ? !line.includes(marker) : !pattern.test(line.toString("latin1"))) return;
        try {
          out.push(project(JSON.parse(line.toString("utf8")), request.fields));
        } catch {
          // Malformed JSONL lines do not contribute usage.
        }
      };
      const buffer = Buffer.allocUnsafe(request.readBufferBytes);
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let scanOffset = 0;
      let resumeOffset = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, scanOffset);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(10, start);
          const segment = chunk.subarray(start, end === -1 ? chunk.length : end);
          if (end !== -1 && pendingBytes === 0) {
            parse(segment, records);
          } else {
            // The existing streaming projector handles arbitrarily large lines.
            if (pendingBytes + segment.length > request.lineLimit) return { kind: "fallback" };
            if (segment.length > 0) {
              pending.push(Buffer.from(segment));
              pendingBytes += segment.length;
            }
            if (end !== -1) {
              parse(
                pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes),
                records,
              );
              pending = [];
              pendingBytes = 0;
            }
          }
          if (end === -1) break;
          start = end + 1;
          resumeOffset = scanOffset + start;
        }
        scanOffset += bytesRead;
      }
      if (pendingBytes > 0) {
        parse(
          pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes),
          tailRecords,
        );
      }
      const guardLength = Math.min(request.guardBytes, resumeOffset);
      let guardHash = 0;
      if (guardLength > 0) {
        const guard = Buffer.alloc(guardLength);
        await handle.read(guard, 0, guardLength, resumeOffset - guardLength);
        let hash = 0x811c9dc5;
        for (const byte of guard) {
          hash ^= byte;
          hash = Math.imul(hash, 0x01000193);
        }
        guardHash = hash >>> 0;
      }
      return {
        kind: "parsed",
        records,
        tailRecords,
        position: { resumeOffset, guardLength, guardHash },
      };
    } catch {
      return { kind: "unreadable" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  port.on("message", (request: ProjectionRequest) => {
    void read(request).then((reply) => port.postMessage(reply));
  });
}

export const projectionWorkerSource = `(${projectionWorker.toString()})()`;
