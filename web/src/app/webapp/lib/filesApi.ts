// Same-origin helpers for durable chat files (upload / search / fetch back / delete). Every attachment
// the user sends is kept in object storage with its AI-written description as the searchable text, so
// the assistant can find it again months later and hand it back. Uploading is best-effort and must never
// interfere with the chat — every helper swallows its errors and returns an empty/null result instead of
// throwing. Only the file, its description and the vector are sent; the user's key stays local.

import { api } from "../authApi";
import type { PreparedFile } from "./files";

export type StoredFileMeta = {
  id: number;
  name: string;
  kind: "image" | "pdf" | "audio" | "text";
  mime: string;
  sizeBytes: number;
  description: string;
  createdAt: string;
  // Vector distance (lower = better) on pure-vector hits; hybrid relevance score (higher = better) on
  // keyword/fused hits. Both are absent on newest-first listings — mirrors MemoryHit.
  distance?: number | null;
  score?: number | null;
};

/** Server shape of a file row (ChatFilesController.FileHit). Mapped to StoredFileMeta below. */
type FileHit = {
  id: number;
  fileName: string;
  kind: string;
  mime: string;
  sizeBytes: number;
  description: string;
  createdAt: string;
  distance?: number | null;
  score?: number | null;
};

/** Server shape of a file's bytes (ChatFilesController.FileData). */
type FileData = {
  id: number;
  fileName: string;
  kind: string;
  mime: string;
  sizeBytes: number;
  base64?: string | null;
  text?: string | null;
};

/** `kind` is a plain string on the wire; narrow it here so callers get the union (default "text"). */
function toKind(kind: string): StoredFileMeta["kind"] {
  return kind === "image" || kind === "pdf" || kind === "audio" ? kind : "text";
}

function toMeta(h: FileHit): StoredFileMeta {
  return {
    id: h.id,
    name: h.fileName,
    kind: toKind(h.kind),
    mime: h.mime,
    sizeBytes: h.sizeBytes,
    description: h.description ?? "",
    createdAt: h.createdAt,
    distance: h.distance ?? null,
    score: h.score ?? null,
  };
}

/** Upload one prepared attachment for durable recall. Returns its id, or null if it didn't store. */
export async function uploadChatFile(
  conversationId: string,
  f: PreparedFile,
  description: string,
  embedding?: number[],
): Promise<number | null> {
  try {
    const res = await api("/api/chat/files", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        fileName: f.name,
        kind: f.kind,
        mime: f.mimeType,
        sizeBytes: f.size,
        base64: f.base64,
        text: f.text,
        description,
        embedding,
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: number };
      return typeof body.id === "number" ? body.id : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function searchChatFiles(
  vector: number[] | null,
  q: string,
  k = 8,
  opts?: { kind?: string; since?: string; until?: string },
): Promise<StoredFileMeta[]> {
  try {
    const res = await api("/api/chat/files/search", {
      method: "POST",
      body: JSON.stringify({ vector, q, k, kind: opts?.kind, since: opts?.since, until: opts?.until }),
    });
    if (res.ok) return ((await res.json()) as FileHit[]).map(toMeta);
  } catch {
    /* ignore */
  }
  return [];
}

export async function getChatFile(id: number): Promise<StoredFileMeta | null> {
  try {
    const res = await api(`/api/chat/files/${id}`);
    if (res.ok) return toMeta((await res.json()) as FileHit);
  } catch {
    /* ignore */
  }
  return null;
}

/** Re-materialize a stored file as a PreparedFile so it renders exactly like a fresh attachment. */
export async function fetchChatFileContent(id: number): Promise<PreparedFile | null> {
  try {
    const res = await api(`/api/chat/files/${id}/data`);
    if (!res.ok) return null;
    const d = (await res.json()) as FileData;
    const kind = toKind(d.kind);
    const pf: PreparedFile = {
      id: crypto.randomUUID(),
      name: d.fileName,
      size: d.sizeBytes,
      kind,
      mimeType: d.mime,
      base64: d.base64 ?? undefined,
      text: d.text ?? undefined,
    };
    // The image preview path renders from dataUrl, not base64 — rebuild it so a restored image shows
    // its thumbnail (and opens in the lightbox) just like one the user just picked.
    if (kind === "image" && pf.base64) pf.dataUrl = `data:${d.mime};base64,${pf.base64}`;
    return pf;
  } catch {
    /* ignore */
  }
  return null;
}

export async function deleteChatFile(id: number): Promise<void> {
  try {
    await api(`/api/chat/files/${id}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}
