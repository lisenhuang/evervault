// Attachment preparation for the app. Images come from the photo library (base64 inline); documents come
// from the system document picker — PDFs go inline as base64, text-like files are read as text and
// embedded into the prompt. Mirrors the web's files.ts, adapted to Expo pickers + the legacy FileSystem
// reader (stable across SDKs).

import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";

import { uid } from "./uid";

export type PreparedFile = {
  id: string;
  name: string;
  size: number;
  kind: "image" | "pdf" | "text";
  mimeType: string;
  /** Inline payload for kind "image" | "pdf". */
  base64?: string;
  /** Local uri for previewing an image. */
  uri?: string;
  /** Extracted content for kind "text". */
  text?: string;
};

export const MAX_FILES = 9;
/** Combined inline payload budget per message (base64/text chars ≈ bytes on the wire). */
export const MAX_TOTAL_INLINE = 15_000_000;
const MaxBinaryBytes = 10_000_000;
const MaxTextBytes = 5_000_000;
const MaxTextChars = 120_000;

export function inlineSize(f: PreparedFile): number {
  return f.base64?.length ?? f.text?.length ?? 0;
}

const TextExtensions = new Set([
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml", "html", "htm", "xml",
  "svg", "rtf", "log", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp",
  "cs", "go", "rs", "rb", "php", "sh", "sql", "toml", "ini", "css",
]);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PickResult = { files: PreparedFile[]; errors: string[] };

/** Pick one or more images from the photo library (returns base64-inlined images). */
export async function pickImages(): Promise<PickResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { files: [], errors: ["Photo access is needed to attach images."] };

  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: MAX_FILES,
    quality: 0.7,
    base64: true,
  });
  if (res.canceled) return { files: [], errors: [] };

  const files: PreparedFile[] = [];
  const errors: string[] = [];
  for (const a of res.assets) {
    if (!a.base64) {
      errors.push(`Couldn't read ${a.fileName ?? "an image"}.`);
      continue;
    }
    const mimeType = a.mimeType ?? "image/jpeg";
    files.push({
      id: uid(),
      name: a.fileName ?? `image-${files.length + 1}.jpg`,
      size: a.fileSize ?? Math.floor((a.base64.length * 3) / 4),
      kind: "image",
      mimeType,
      base64: a.base64,
      uri: a.uri,
    });
  }
  return { files, errors };
}

/** Pick one or more documents (PDF / text / code). */
export async function pickDocuments(): Promise<PickResult> {
  const res = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    type: ["application/pdf", "text/*", "application/json", "application/xml"],
  });
  if (res.canceled) return { files: [], errors: [] };

  const files: PreparedFile[] = [];
  const errors: string[] = [];
  for (const a of res.assets) {
    try {
      const prepared = await prepareDocument(a);
      if (prepared) files.push(prepared);
    } catch {
      errors.push(`Couldn't attach ${a.name}.`);
    }
  }
  return { files, errors };
}

async function prepareDocument(a: DocumentPicker.DocumentPickerAsset): Promise<PreparedFile | null> {
  const name = a.name || "attachment";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const size = a.size ?? 0;
  const mime = a.mimeType ?? "";

  if (mime === "application/pdf" || ext === "pdf") {
    if (size > MaxBinaryBytes) throw new Error("too-large");
    const base64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
    return { id: uid(), name, size, kind: "pdf", mimeType: "application/pdf", base64 };
  }

  if (mime.startsWith("image/")) {
    if (size > MaxBinaryBytes) throw new Error("too-large");
    const base64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
    return { id: uid(), name, size, kind: "image", mimeType: mime, base64, uri: a.uri };
  }

  if (mime.startsWith("text/") || TextExtensions.has(ext) || mime === "application/json" || mime === "application/xml") {
    if (size > MaxTextBytes) throw new Error("too-large");
    const raw = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.UTF8 });
    const text = raw.trim();
    if (!text) throw new Error("unreadable");
    return { id: uid(), name, size, kind: "text", mimeType: mime || "text/plain", text: clip(text) };
  }

  throw new Error("unsupported");
}

function clip(text: string): string {
  return text.length <= MaxTextChars ? text : `${text.slice(0, MaxTextChars)}\n…[file truncated]`;
}
