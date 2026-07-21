// Same-origin helpers for the chat-memory API (record / recall / manage). Recording is fire-and-forget
// so it never interferes with the chat. Only content + vectors are sent — the user's key stays local.

import { api, postJsonBeacon } from "./authApi";

export type TurnItem = {
  role: "user" | "assistant";
  modality: "text" | "voice" | "live" | "image";
  text?: string;
  audioBase64?: string;
  audioMime?: string;
  imageBase64?: string;
  imageMime?: string;
  embedding?: number[];
};

export type MemoryHit = {
  id: number;
  role: string;
  modality: string;
  kind: string; // "turn" | "summary"
  content: string;
  hasAudio: boolean;
  hasImage: boolean;
  createdAt: string;
  distance: number | null;
  /** Synthetic for a digest ("digest:2026-W29"), the real conversation otherwise. Absent when talking
   *  to a server that predates it. */
  conversationId?: string | null;
  // Hybrid-search relevance (higher = better); set on keyword/fused hits, null on pure-vector and
  // legacy paths (and absent when talking to an older server).
  score?: number | null;
};

export function recordTurn(conversationId: string, turns: TurnItem[]): void {
  if (turns.length === 0) return;
  // Beacon-style so a turn recorded as the tab closes still lands; a turn carrying base64 audio or an
  // image is too big for keepalive and falls back to a plain request (see postJsonBeacon).
  void postJsonBeacon("/api/chat/memories", { conversationId, turns }).catch(() => {});
}

export async function searchMemories(
  vector: number[] | null,
  q: string,
  k = 8,
  opts?: { since?: string; until?: string; kind?: string },
): Promise<MemoryHit[]> {
  try {
    const res = await api("/api/chat/memories/search", {
      method: "POST",
      body: JSON.stringify({ vector, q, k, since: opts?.since, until: opts?.until, kind: opts?.kind }),
    });
    if (res.ok) return (await res.json()) as MemoryHit[];
  } catch {
    /* ignore */
  }
  return [];
}

/** Upsert the single episodic summary for a conversation (replaces any prior one). Fire-and-forget.
 *  `kind` defaults to "summary"; "digest" writes a rolled-up period note and requires a synthetic
 *  "digest:" conversation id (the server enforces both). */
export function upsertSummary(
  conversationId: string,
  text: string,
  embedding?: number[],
  kind?: "summary" | "digest",
): void {
  if (!text.trim()) return;
  void postJsonBeacon("/api/chat/memories/summary", {
    conversationId,
    text,
    embedding,
    ...(kind ? { kind } : {}),
  }).catch(() => {});
}

export async function deleteMemory(id: number): Promise<void> {
  try {
    await api(`/api/chat/memories/${id}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

export async function clearAllMemories(): Promise<void> {
  try {
    await api("/api/chat/memories?all=true", { method: "DELETE" });
  } catch {
    /* ignore */
  }
}
