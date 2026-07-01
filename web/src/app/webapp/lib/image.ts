// Client-side image preparation for chat attachments. Large photos are downscaled and re-encoded to
// JPEG on a canvas so the inline payload stays small for both Gemini (inlineData) and our backend
// (base64 in the record call). Small files pass through untouched to preserve their original format.

export type PreparedImage = { base64: string; mimeType: string; dataUrl: string };

/** Files at or below this size are sent as-is; larger ones are downscaled/re-encoded. */
const PassThroughBytes = 1_000_000;
/** Longest edge after downscaling — plenty for recognition while keeping payloads ~100-500KB. */
const MaxEdge = 2048;

const AcceptedTypes = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

export function isAcceptedImage(file: File): boolean {
  return AcceptedTypes.test(file.type);
}

/** Read, and if needed downscale/re-encode, an attached image. Throws on unreadable files. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size <= PassThroughBytes && /^image\/(jpeg|png|webp|gif)$/i.test(file.type)) {
    const dataUrl = await readAsDataUrl(file);
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: file.type, dataUrl };
  }

  const bitmap = await loadImage(file);
  const scale = Math.min(1, MaxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process the image.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg", dataUrl };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Could not read the image."));
    r.readAsDataURL(file);
  });
}

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Fallback (e.g. HEIC on browsers where createImageBitmap rejects it but <img> decodes it).
    const url = URL.createObjectURL(file);
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Unsupported image format."));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
