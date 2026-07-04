// Chat-memory API (record / recall / manage) for the app. Same endpoints the web uses; only content +
// vectors are sent. Recording is fire-and-forget so it never interferes with the chat.

import { apiFetch } from "@/lib/api";

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
};

export function recordTurn(conversationId: string, turns: TurnItem[]): void {
  if (turns.length === 0) return;
  void apiFetch("/chat/memories", {
    method: "POST",
    body: JSON.stringify({ conversationId, turns }),
  }).catch(() => {});
}

export async function searchMemories(
  vector: number[] | null,
  q: string,
  k = 8,
  opts?: { since?: string; until?: string; kind?: string },
): Promise<MemoryHit[]> {
  try {
    const res = await apiFetch("/chat/memories/search", {
      method: "POST",
      body: JSON.stringify({ vector, q, k, since: opts?.since, until: opts?.until, kind: opts?.kind }),
    });
    if (res.ok) return (await res.json()) as MemoryHit[];
  } catch {
    /* ignore */
  }
  return [];
}

/** Upsert the single episodic summary for a conversation (replaces any prior one). Fire-and-forget. */
export function upsertSummary(conversationId: string, text: string, embedding?: number[]): void {
  if (!text.trim()) return;
  void apiFetch("/chat/memories/summary", {
    method: "POST",
    body: JSON.stringify({ conversationId, text, embedding }),
  }).catch(() => {});
}

export async function clearAllMemories(): Promise<void> {
  try {
    await apiFetch("/chat/memories?all=true", { method: "DELETE" });
  } catch {
    /* ignore */
  }
}
