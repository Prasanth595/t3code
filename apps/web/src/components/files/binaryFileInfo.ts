import { isWindowsAbsolutePath } from "@t3tools/shared/path";

const DOCUMENT_KINDS = [
  [/^(ppt|pptx)$/, "PowerPoint presentation"],
  [/^(doc|docx|rtf)$/, "Word document"],
  [/^(xls|xlsx|ods)$/, "Spreadsheet"],
  [/^odp$/, "OpenDocument presentation"],
  [/^odt$/, "OpenDocument text"],
  [/^pages$/, "Pages document"],
  [/^numbers$/, "Numbers spreadsheet"],
  [/^key$/, "Keynote presentation"],
  [/^pdf$/, "PDF document"],
] as const;

const DISPLAY_KINDS = [
  [/^(zip|gz|bz2|xz|7z|rar|tar)$/, "Archive"],
  [/^(ttf|otf|woff|woff2)$/, "Font"],
  [/^(glb|gltf|obj|stl|fbx|usdz)$/, "3D model"],
  [/^(png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|ico|psd)$/, "Image"],
  [/^(mp3|wav|flac|ogg|m4a|aac|aiff)$/, "Audio"],
  [/^(mp4|webm|mov|mkv|avi|m4v)$/, "Video"],
] as const;

export function binaryFileInfo(path: string) {
  const { filePath: name } = fileMenuTarget(path);
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  const document = extension && DOCUMENT_KINDS.find(([pattern]) => pattern.test(extension));
  const match =
    document || (extension && DISPLAY_KINDS.find(([pattern]) => pattern.test(extension)));
  return {
    name,
    kind: match ? match[1] : extension ? `${extension.toUpperCase()} file` : "Binary file",
    canOpenDefault: Boolean(document),
  };
}

// The menu requires a relative path under a root, including for host files.
export function fileMenuTarget(absolutePath: string) {
  const separator = isWindowsAbsolutePath(absolutePath)
    ? Math.max(absolutePath.lastIndexOf("/"), absolutePath.lastIndexOf("\\"))
    : absolutePath.lastIndexOf("/");
  return {
    filePath: absolutePath.slice(separator + 1),
    workspaceRoot: absolutePath.slice(0, separator + 1),
  };
}
