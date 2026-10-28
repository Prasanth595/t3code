/** Resolves web references without inheriting the desktop renderer's custom app scheme. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

async function readMediaBlob(src: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(src);
  } catch (cause) {
    throw new Error(
      "Fișierul nu a putut fi descărcat. Gazda poate bloca accesul din browser (CORS) sau conexiunea nu e disponibilă.",
      { cause },
    );
  }
  if (!response.ok) throw new Error(`Fișierul nu a putut fi descărcat (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (blob.type.split(";", 1)[0] === "text/html") {
    throw new Error(
      "Link-ul a returnat o pagină web în loc de fișier media. Deschide adresa originală.",
    );
  }
  return blob;
}

export async function downloadMedia(src: string, name: string): Promise<void> {
  const url = URL.createObjectURL(await readMediaBlob(src));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function readMediaPng(src: string): Promise<Blob> {
  const blob = await readMediaBlob(src);
  if (blob.type.split(";", 1)[0] === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    try {
      await image.decode();
    } catch (cause) {
      throw new Error(
        "Browserul nu a putut decoda imaginea pentru copiere. Încearcă s-o salvezi.",
        {
          cause,
        },
      );
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width <= 0 || height <= 0 || width * height > 64_000_000) {
      throw new Error(
        "Imaginea e prea mare sau nu are dimensiuni utilizabile. Încearcă s-o salvezi.",
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Copierea imaginilor nu e disponibilă în acest browser.");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error("Imaginea nu a putut fi convertită în PNG.")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
