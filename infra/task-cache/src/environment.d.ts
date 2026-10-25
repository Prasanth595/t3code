// The pinned protocol package consumes native Cloudflare bindings.
import type * as Cloudflare from "@cloudflare/workers-types";

declare global {
  interface Env {
    INDEX: Cloudflare.D1Database;
    ARTIFACTS: Omit<Cloudflare.R2Bucket, "get"> & {
      get(key: string): Promise<
        | (Omit<Cloudflare.R2ObjectBody, "body"> & {
            body: ReadableStream<Uint8Array>;
          })
        | null
      >;
    };
    GC_BATCH_SIZE: string;
  }
  type D1Database = Cloudflare.D1Database;
  type D1Result<T = unknown> = Cloudflare.D1Result<T>;
  type R2MultipartUpload = Cloudflare.R2MultipartUpload;
  type R2UploadedPart = Cloudflare.R2UploadedPart;
  type ExecutionContext = Cloudflare.ExecutionContext;
}
