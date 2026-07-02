// Client-side preparation of chat attachments. Images keep the downscale path in image.ts; PDFs go
// to Gemini as inline base64; anything text-like (Markdown, CSV, source code, SVG, …) is read as
// text and embedded into the prompt; .docx is converted to plain text in the browser (mammoth,
// loaded on demand). Legacy .doc has no reliable browser parser and is rejected with a clear error.

import { isAcceptedImage, prepareImage } from "./image";

export type PreparedFile = {
  id: string;
  name: string;
  /** Size in bytes of the original file (shown on the composer/message chip). */
  size: number;
  kind: "image" | "pdf" | "text";
  mimeType: string;
  /** Inline payload for kind "image" | "pdf". */
  base64?: string;
  /** Preview URL for kind "image". */
  dataUrl?: string;
  /** Extracted content for kind "text". */
  text?: string;
};

/** Max attachments per message. */
export const MAX_FILES = 9;

/**
 * Combined inline payload budget per message (base64/text chars, ≈ bytes on the wire). Gemini
 * inline requests top out at ~20MB total, and attachments are replayed with the history on every
 * later turn — so one message's attachments must stay comfortably under the cap.
 */
export const MAX_TOTAL_INLINE = 15_000_000;

/** How much of the inline budget one prepared file consumes. */
export function inlineSize(f: PreparedFile): number {
  return f.base64?.length ?? f.text?.length ?? 0;
}

/** Gemini inline requests top out at 20MB total, so each binary file stays well under that. */
const MaxPdfBytes = 10_000_000;
/** Text files are read whole up to this size, then the extracted text is clipped below. */
const MaxTextBytes = 5_000_000;
/** Extracted text is clipped to keep the prompt sane (~30k tokens per file). */
const MaxTextChars = 120_000;

const TextExtensions = new Set([
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml", "html", "htm", "xml",
  "svg", "rtf", "log", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp",
  "cs", "go", "rs", "rb", "php", "sh", "sql", "toml", "ini", "css",
]);
const TextMimes = new Set([
  "application/json", "application/xml", "application/rtf", "application/x-yaml",
  "application/javascript", "application/typescript", "application/sql", "image/svg+xml",
]);

const DocxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DocMime = "application/msword";

/** `accept` for the general picker: images + every document type we can handle. */
export const FILE_ACCEPT = [
  "image/*",
  "application/pdf",
  DocxMime,
  DocMime,
  ".pdf", ".docx", ".doc",
  ...[...TextExtensions].map((e) => `.${e}`),
].join(",");

/** `accept` for the iOS "Photo Library" picker. */
export const IMAGE_ACCEPT = "image/*";

export type FileErrorCode = "unsupported" | "too-large" | "legacy-doc" | "unreadable";

/** Why a file couldn't be attached — carries the file name for the user-facing message. */
export class FileError extends Error {
  constructor(
    public code: FileErrorCode,
    public fileName: string,
  ) {
    super(`${code}: ${fileName}`);
  }
}

/** Read + convert one attached file. Throws {@link FileError} when it can't be attached. */
export async function prepareFile(file: File): Promise<PreparedFile> {
  const id = crypto.randomUUID();
  const name = file.name || "attachment";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

  if (isAcceptedImage(file)) {
    let img;
    try {
      img = await prepareImage(file);
    } catch {
      throw new FileError("unreadable", name);
    }
    return { id, name, size: file.size, kind: "image", mimeType: img.mimeType, base64: img.base64, dataUrl: img.dataUrl };
  }

  if (file.type === "application/pdf" || ext === "pdf") {
    if (file.size > MaxPdfBytes) throw new FileError("too-large", name);
    return { id, name, size: file.size, kind: "pdf", mimeType: "application/pdf", base64: await readAsBase64(file, name) };
  }

  if (file.type === DocxMime || ext === "docx") {
    if (file.size > MaxPdfBytes) throw new FileError("too-large", name);
    let text: string;
    try {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value.trim();
    } catch {
      throw new FileError("unreadable", name);
    }
    if (!text) throw new FileError("unreadable", name);
    return { id, name, size: file.size, kind: "text", mimeType: "text/plain", text: clip(text) };
  }

  // Word 97-2003 binary format — nothing in the browser extracts it reliably; ask for docx/PDF.
  if (file.type === DocMime || ext === "doc") throw new FileError("legacy-doc", name);

  if (file.type.startsWith("text/") || TextMimes.has(file.type) || TextExtensions.has(ext)) {
    if (file.size > MaxTextBytes) throw new FileError("too-large", name);
    let text: string;
    try {
      text = (await file.text()).trim();
    } catch {
      throw new FileError("unreadable", name);
    }
    if (!text) throw new FileError("unreadable", name);
    return { id, name, size: file.size, kind: "text", mimeType: file.type || "text/plain", text: clip(text) };
  }

  throw new FileError("unsupported", name);
}

function clip(text: string): string {
  return text.length <= MaxTextChars ? text : `${text.slice(0, MaxTextChars)}\n…[file truncated]`;
}

function readAsBase64(file: File, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    r.onerror = () => reject(new FileError("unreadable", name));
    r.readAsDataURL(file);
  });
}

/** "824 B" / "312 KB" / "4.2 MB" — for the attachment chips. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
