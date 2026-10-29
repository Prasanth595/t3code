import { GitLfsOid } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const LFS_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const LFS_IMAGE_MAX_PIXELS = 32 * 1024 * 1024;
export const LFS_POINTER_MAX_LENGTH = 1024;

const isGitLfsOid = Schema.is(GitLfsOid);

// These formats have dimensions the server can inspect before browser decoding.
const LFS_IMAGE_PREVIEW_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

export function isLfsImagePreviewPath(path: string): boolean {
  const literalPath = path.toLowerCase();
  return LFS_IMAGE_PREVIEW_EXTENSIONS.some((extension) => literalPath.endsWith(extension));
}

/** Only complete, plain v1 pointers are previewable; extensions can transform the stored bytes. */
export function parseLfsPointer(contents: string) {
  if (contents.length >= LFS_POINTER_MAX_LENGTH) return null;
  // This URL identifies the Git LFS pointer format, regardless of repository host; it is never fetched.
  const match =
    /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([^\n]+)\nsize (0|[1-9][0-9]*)\n?$/.exec(
      contents,
    );
  if (!match || !isGitLfsOid(match[1])) return null;
  const size = Number(match[2]);
  return Number.isSafeInteger(size) ? { oid: match[1]!, size } : null;
}
