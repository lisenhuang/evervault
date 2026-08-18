// Client-side preparation of chat attachments. Images keep the downscale path in image.ts; PDFs and
// audio go to Gemini as inline base64 (the chat text model is audio-capable, so it transcribes and
// understands uploaded clips directly); anything text-like (Markdown, CSV, source code, SVG, …) is
// read as text and embedded into the prompt; .docx is converted to plain text in the browser
// (mammoth, loaded on demand). Legacy .doc has no reliable browser parser and is rejected clearly.

import { isAcceptedImage, prepareImage } from "./image";

export type PreparedFile = {
  id: string;
  name: string;
  /** Size in bytes of the original file (shown on the composer/message chip). */
  size: number;
  kind: "image" | "pdf" | "audio" | "text";
  mimeType: string;
  /** Inline payload for kind "image" | "pdf" | "audio". */
  base64?: string;
  /** Preview URL for kind "image". */
  dataUrl?: string;
  /** Extracted content for kind "text". */
  text?: string;
  /**
   * The stored ChatFile row this came from, for an attachment restored from history rather than picked
   * in the composer. Such a file deliberately carries NO bytes: a reopened conversation can hold dozens
   * of them, and inlining every one would download the whole chat's attachments to show a thumbnail.
   */
  remoteId?: number;
  /**
   * Same-origin URL the bytes can be read from, set alongside {@link remoteId}. An `<img>`, `<audio>` or
   * PDF frame pointed here loads on demand and is cached by the browser, which is why a restored
   * attachment needs no base64 to render.
   */
  url?: string;
};

/** Max attachments per message. */
export const MAX_FILES = 9;

/**
 * Combined inline payload budget per message (base64/text chars, ≈ bytes on the wire). Gemini
 * inline requests top out at ~20MB total, and attachments are replayed with the history on every
 * later turn — so one message's attachments must stay comfortably under the cap.
 */
export const MAX_TOTAL_INLINE = 15_000_000;

/**
 * Ceiling for ONE voice turn's inline payload: the attachments PLUS the recorded clip, which
 * {@link MAX_TOTAL_INLINE} does not account for (that budget is enforced in the composer, over files
 * only, before any recording exists).
 *
 * The clip itself is bounded — Composer's RECORD_LIMIT stops and sends at 99 s, which at 16 kHz mono
 * PCM16 (~42,700 base64 characters per second) is at most ~4.2 MB. So this is NOT a guard against a long
 * recording; it exists for the one combination that can still overshoot: attachments at or near the full
 * 15 MB file budget, plus a clip, plus replayed history. Rather than send something that may be rejected
 * mid-upload — which reaches the browser as an opaque gateway error saying nothing about size — the turn
 * degrades on its own terms and sends the transcript instead of the audio (see runTtsVoiceTurn).
 *
 * Deliberately well under the backend's own limit so the client is always the first to notice.
 */
export const MAX_VOICE_INLINE = 18_000_000;

/** Base64 characters per second of recorded speech (16 kHz mono PCM16 → 32,000 B/s → 4/3 in base64).
 *  Exported so the composer can warn about a long recording before it is ever sent. */
export const VOICE_BASE64_CHARS_PER_SECOND = 42_667;

/** How much of the inline budget one prepared file consumes. */
export function inlineSize(f: PreparedFile): number {
  return f.base64?.length ?? f.text?.length ?? 0;
}

/** Gemini inline requests top out at 20MB total, so each binary file stays well under that. */
const MaxPdfBytes = 10_000_000;
/** Same inline budget for audio (base64 of 10MB ≈ 13.3MB, under MAX_TOTAL_INLINE). ~10min of MP3. */
const MaxAudioBytes = 10_000_000;
/** Text files are read whole up to this size, then the extracted text is clipped below. */
const MaxTextBytes = 5_000_000;
/** Extracted text is clipped to keep the prompt sane (~30k tokens per file). Exported so the
 *  pptx/xlsx extractors can spend the same budget a record at a time, cutting on a slide or sheet
 *  boundary instead of mid-row. */
export const MaxTextChars = 120_000;

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
const PptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Macro-enabled and template variants are the same ZIP+XML package as the plain one, so they parse
// identically — .xlsm in particular is everywhere in business workbooks.
const PptxExtensions = new Set(["pptx", "pptm", "ppsx", "potx"]);
const XlsxExtensions = new Set(["xlsx", "xlsm", "xltx"]);

// Office 97-2003 binaries. These are OLE2/CFB containers, not zips, and nothing in the browser
// extracts them reliably — the only real .xls reader is SheetJS's full build at ~300KB gzipped, for
// a format Office and Google Drive both re-save in one click. Rejected with a message that says so.
const LegacyOfficeMimes = new Set([
  "application/msword",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-excel",
]);
const LegacyOfficeExtensions = new Set(["doc", "ppt", "pps", "pot", "xls", "xlt"]);

// Audio the chat model can take inline. Keyed by extension so we can fill in a Gemini-friendly mime
// when the browser reports none — and normalize the mp3 case (browsers say audio/mpeg, Gemini wants
// audio/mp3). Anything the model can't decode surfaces as a normal chat error.
const AudioMimeByExt: Record<string, string> = {
  mp3: "audio/mp3", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  aiff: "audio/aiff", aif: "audio/aiff",
};
const AudioExtensions = new Set(Object.keys(AudioMimeByExt));

function audioMime(file: File, ext: string): string {
  if (file.type === "audio/mpeg") return "audio/mp3";
  if (file.type.startsWith("audio/")) return file.type;
  return AudioMimeByExt[ext] ?? "audio/mp3";
}

/** `accept` for the general picker: images + audio + every document type we can handle. */
export const FILE_ACCEPT = [
  "image/*",
  "audio/*",
  "application/pdf",
  DocxMime,
  PptxMime,
  XlsxMime,
  ...LegacyOfficeMimes,
  ".pdf", ".docx",
  ...[...PptxExtensions].map((e) => `.${e}`),
  ...[...XlsxExtensions].map((e) => `.${e}`),
  // Listed so the legacy formats stay selectable and get a real explanation, rather than being
  // greyed out in the picker with no hint as to why.
  ...[...LegacyOfficeExtensions].map((e) => `.${e}`),
  ...[...AudioExtensions].map((e) => `.${e}`),
  ...[...TextExtensions].map((e) => `.${e}`),
].join(",");

/** `accept` for the iOS "Photo Library" picker. */
export const IMAGE_ACCEPT = "image/*";

export type FileErrorCode =
  | "unsupported"
  | "too-large"
  | "legacy-office"
  | "no-text"
  | "unreadable";

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

  if (file.type.startsWith("audio/") || AudioExtensions.has(ext)) {
    if (file.size > MaxAudioBytes) throw new FileError("too-large", name);
    return { id, name, size: file.size, kind: "audio", mimeType: audioMime(file, ext), base64: await readAsBase64(file, name) };
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
    return { id, name, size: file.size, kind: "text", mimeType: "text/plain", text: clip(sanitizeExtractedText(text)) };
  }

  // PowerPoint and Excel, like docx: parsed here and sent as text, because Gemini rejects OOXML
  // outright (400 "Unsupported MIME type") — only PDF gets its document-vision path. Both branches
  // sit above the generic-text branch on purpose: a deck the OS mis-reports as text/plain would
  // otherwise be read with file.text() and reach the model as decoded ZIP binary. The size gate is
  // MaxPdfBytes because it applies to the compressed original, not the extracted text.
  if (file.type === PptxMime || PptxExtensions.has(ext)) {
    if (file.size > MaxPdfBytes) throw new FileError("too-large", name);
    const { extractPptx } = await import("./office");
    // No clip() — the extractor spends MaxTextChars itself so it can cut between slides.
    return { id, name, size: file.size, kind: "text", mimeType: "text/plain", text: await extractPptx(file, name) };
  }

  if (file.type === XlsxMime || XlsxExtensions.has(ext)) {
    if (file.size > MaxPdfBytes) throw new FileError("too-large", name);
    const { extractXlsx } = await import("./office");
    return { id, name, size: file.size, kind: "text", mimeType: "text/plain", text: await extractXlsx(file, name) };
  }

  if (LegacyOfficeMimes.has(file.type) || LegacyOfficeExtensions.has(ext)) {
    throw new FileError("legacy-office", name);
  }

  if (file.type.startsWith("text/") || TextMimes.has(file.type) || TextExtensions.has(ext)) {
    if (file.size > MaxTextBytes) throw new FileError("too-large", name);
    let text: string;
    try {
      text = (await file.text()).trim();
    } catch {
      throw new FileError("unreadable", name);
    }
    if (!text) throw new FileError("unreadable", name);
    if (looksBinary(text)) throw new FileError("unsupported", name);
    return { id, name, size: file.size, kind: "text", mimeType: file.type || "text/plain", text: clip(text) };
  }

  throw new FileError("unsupported", name);
}

/**
 * Whether decoded "text" is really a binary someone renamed. A .pptx saved as notes.txt still says
 * `text/plain`, so nothing above catches it and `file.text()` happily hands back 100KB of mojibake
 * headed straight for the prompt. Deflated bytes decode to a dense run of U+FFFD and control
 * characters; real text, in any language, has almost none.
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (!sample) return false;
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0xfffd || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) odd += 1;
  }
  return odd / sample.length > 0.02;
}

function clip(text: string): string {
  return text.length <= MaxTextChars ? text : `${text.slice(0, MaxTextChars)}\n…[file truncated]`;
}

/**
 * Defuse forged prompt fences in text we extracted from a document. Attachment text is sent to the
 * model wrapped in `--- Attached file: X ---` … `--- End of file: X ---`, so a document containing
 * that line verbatim could close the fence early and have the rest of itself read as instructions
 * rather than as quoted data. Swapping the hyphens for en dashes keeps the line readable to the
 * model while making it stop looking like our delimiter.
 *
 * Applied to text we parsed out of a binary container (docx/pptx/xlsx), where the line can only be
 * deliberate — not to plain-text files, where a Markdown rule above such a heading is plausible.
 */
export function sanitizeExtractedText(text: string): string {
  return text.replace(/^[ \t]*-{2,}[ \t]*(?=(Attached|End of) file\b)/gim, (fence) =>
    fence.replace(/-/g, "–"),
  );
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

/**
 * How long an object URL stays alive after we're done with it, before we reclaim its memory. Long
 * enough that a tab we just handed it to has loaded it, and that a dismissed preview can't yank the
 * URL out from under a viewer the user opened from it. Shared by both handoff paths.
 */
export const HandoffRevokeMs = 60_000;

/**
 * A blob object URL for a prepared file's inline bytes, or `null` for kind "text" (its content is
 * already in memory as a string — there is nothing to fetch). A blob URL, never a `data:` URL:
 * Chrome blocks top-level navigation to `data:`, and a 10MB base64 string is far heavier to hand to
 * an `<iframe>`/`<a>` than a blob the browser can stream.
 *
 * The caller owns the returned URL and **must** `URL.revokeObjectURL` it — one leaked 10MB PDF per
 * preview adds up fast over a long session.
 */
export function fileObjectUrl(f: PreparedFile): string | null {
  if (f.kind === "text" || !f.base64) return null;
  const bin = atob(f.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: f.mimeType }));
}

/**
 * Hand a file straight to the browser/OS in a new tab. This is the iOS PDF path: WebKit refuses to
 * render a PDF inside an `<iframe>`, so instead of showing a blank preview panel we push the blob at
 * the system viewer. A synthesized anchor click rather than `window.open` — an anchor inherits the
 * user's tap as its activation and isn't treated as a popup, which iOS Safari blocks readily.
 */
export function openFileInNewTab(f: PreparedFile): void {
  const blob = fileObjectUrl(f);
  // A restored attachment has no bytes to mint a blob from, but it does have a server URL — and that is
  // strictly better here: there is nothing to revoke, and the new tab fetches it itself.
  const url = blob ?? f.url;
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deliberately NOT revoked synchronously: the new tab hasn't fetched the blob yet, so revoking
  // right after the click leaves it staring at a blank viewer. Give the handoff a generous window,
  // then reclaim — by then the viewer holds its own copy of the bytes.
  // Only a blob URL is ours to reclaim; a server URL has nothing to release.
  if (blob) setTimeout(() => URL.revokeObjectURL(blob), HandoffRevokeMs);
}
