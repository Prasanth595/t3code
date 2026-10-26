import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
} from "@t3tools/client-runtime/image-attachment-size";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

const PHOTO_JPEG_QUALITY = 0.85;

export async function renderPhoto(
  uri: string,
  format: "jpeg" | "png" = "jpeg",
): Promise<{ base64: string; uri: string }> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  let image = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    const fittedSize = fitImageAttachmentSize(image);
    if (fittedSize !== null) {
      const resized = await ImageManipulator.manipulate(image).resize(fittedSize).renderAsync();
      image.release();
      image = resized;
    }
    const saved = await image.saveAsync({
      format: format === "png" ? SaveFormat.PNG : SaveFormat.JPEG,
      compress: PHOTO_JPEG_QUALITY,
      base64: true,
    });
    if (!saved.base64) {
      throw new Error("The rendered photo has no bytes.");
    }
    return { base64: saved.base64, uri: saved.uri };
  } finally {
    image.release();
  }
}

/** Returns null to keep original bytes if they fit, use another format, or native rendering fails. */
export async function fitComposerImage(image: {
  readonly uri: string;
  readonly mimeType: string;
  readonly base64: string;
}): Promise<{ base64: string; uri: string } | null> {
  const mimeType = downscalableImageMimeType(image.mimeType);
  if (mimeType === null) return null;
  try {
    const header = atob(image.base64.slice(0, Math.ceil(IMAGE_DIMENSIONS_HEADER_BYTES / 3) * 4));
    const bytes = new Uint8Array(header.length);
    for (let index = 0; index < header.length; index += 1) bytes[index] = header.charCodeAt(index);
    const dimensions = readImageDimensions(bytes);
    if (dimensions === null || fitImageAttachmentSize(dimensions) === null) return null;
    return await renderPhoto(image.uri, mimeType === "image/png" ? "png" : "jpeg");
  } catch (error) {
    console.warn("[composer-images] could not scale an oversized image", error);
    return null;
  }
}

async function readFileImageDimensions(uri: string) {
  const { File, FileMode } = await import("expo-file-system");
  const reader = new File(uri).open(FileMode.ReadOnly);
  try {
    const header = new Uint8Array(IMAGE_DIMENSIONS_HEADER_BYTES);
    let length = 0;
    while (length < header.length) {
      const chunk = await reader.readBytes(header.length - length);
      if (chunk.byteLength === 0) break;
      header.set(chunk, length);
      length += chunk.byteLength;
    }
    return readImageDimensions(header.subarray(0, length));
  } finally {
    reader.close();
  }
}

/** File imports only need original base64 when it will be kept or a header read is unsupported. */
export async function fitComposerImageFile(image: {
  readonly uri: string;
  readonly mimeType: string;
}): Promise<{ base64: string; uri: string; fitted: boolean }> {
  const { File } = await import("expo-file-system");
  const mimeType = downscalableImageMimeType(image.mimeType);
  // Some content providers allow a full read but do not expose file handles.
  const dimensions =
    mimeType === null ? null : await readFileImageDimensions(image.uri).catch(() => null);
  if (dimensions === null) {
    const base64 = await new File(image.uri).base64();
    const fitted = await fitComposerImage({ ...image, base64 });
    return fitted === null
      ? { base64, uri: image.uri, fitted: false }
      : { ...fitted, fitted: true };
  }
  if (fitImageAttachmentSize(dimensions) !== null) {
    try {
      return {
        ...(await renderPhoto(image.uri, mimeType === "image/png" ? "png" : "jpeg")),
        fitted: true,
      };
    } catch (error) {
      console.warn("[composer-images] could not scale an oversized image", error);
    }
  }
  return { base64: await new File(image.uri).base64(), uri: image.uri, fitted: false };
}
