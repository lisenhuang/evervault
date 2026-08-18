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
  /** The message this file was attached to, when that was recorded. Absent on files stored before the
   *  link existed, and on any server that predates it. */
  clientMessageId?: string | null;
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
  clientMessageId?: string | null;
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
    clientMessageId: h.clientMessageId ?? null,
  };
}

/** Where a stored file's bytes can be read from. Same-origin; the server redirects to a short-lived
 *  storage URL, so an `<img>`/`<audio>`/frame can point straight at it and the browser caches it. */
export function chatFileContentUrl(id: number): string {
  return `/api/chat/files/${id}/content`;
}

/**
 * A stored file as a renderable attachment, WITHOUT downloading it.
 *
 * The counterpart to {@link fetchChatFileContent}, which pulls the bytes inline as base64. That is right
 * for one file the assistant just offered; it is wrong for a reopened conversation, where it would mean
 * downloading every attachment the chat ever held before the first bubble appears. This keeps the row's
 * metadata and points at {@link chatFileContentUrl} instead, so each file loads only if it is actually
 * shown — and the bytes can still be fetched later, on demand, via {@link PreparedFile.remoteId}.
 */
export function storedFileToPrepared(m: StoredFileMeta): PreparedFile {
  return {
    // A fresh client id: this is a distinct on-screen attachment, not the stored row's identity.
    id: crypto.randomUUID(),
    name: m.name,
    size: m.sizeBytes,
    kind: m.kind,
    mimeType: m.mime,
    remoteId: m.id,
    url: chatFileContentUrl(m.id),
    // dataUrl doubles as the composer's preview source; a restored file has no inline copy to build it
    // from, and the renderers prefer `url` anyway.
  };
}

/** Upload one prepared attachment for durable recall. Returns its id, or null if it didn't store. */
export async function uploadChatFile(
  conversationId: string,
  f: PreparedFile,
  description: string,
  embedding?: number[],
  /** The message this file was attached to. Optional so existing callers are unaffected, but passing it
   *  is what lets the attachment come back on the right bubble when the chat is reopened. */
  clientMessageId?: string,
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
        clientMessageId,
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

/**
 * Every file stored for one conversation, oldest first — what a reopened chat reads to put its
 * attachments back on the messages that carried them.
 *
 * Bounded like every other listing here: a conversation with more attachments than this shows the
 * earliest of them, which matches the order the transcript is replayed in.
 */
export async function listConversationFiles(conversationId: string, take = 200): Promise<StoredFileMeta[]> {
  if (!conversationId) return [];
  try {
    const params = new URLSearchParams({ conversationId, take: String(take) });
    const res = await api(`/api/chat/files?${params}`);
    if (res.ok) return ((await res.json()) as FileHit[]).map(toMeta);
  } catch {
    /* offline, or a server that predates the filter — the chat just reopens without its files */
  }
  return [];
}
