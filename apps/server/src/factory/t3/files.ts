import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

/**
 * Writes `contents` to `filePath` whole, so a reader never sees half a file. It creates the
 * directory, follows a symlinked file to its target and leaves no temp file behind. Only
 * `factory/t3/` may import T3 packages, so the rest of the factory writes files through here.
 */
export const writeFileAtomically = (filePath: string, contents: string) =>
  writeFileStringAtomically({ filePath, contents });
