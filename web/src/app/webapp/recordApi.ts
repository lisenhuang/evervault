// Same-origin helpers for the chat-memory API (record / recall / manage). Recording is fire-and-forget
// so it never interferes with the chat. Only content + vectors are sent — the user's key stays local.

import { api } from "./authApi";

export type TurnItem = {
  role: "user" | "assistant";
  modality: "text" | "voice" | "live";
  text?: string;
  audioBase64?: string;
  audioMime?: string;
  embedding?: number[];
};

export type MemoryHit = {
  id: number;
  role: string;
  modality: string;
  content: string;
  hasAudio: boolean;
  createdAt: string;
  distance: number | null;
};

export function recordTurn(conversationId: string, turns: TurnItem[]): void {
  if (turns.length === 0) return;
  void api("/api/chat/memories", {
    method: "POST",
    body: JSON.stringify({ conversationId, turns }),
  }).catch(() => {});
}

export async function searchMemories(
  vector: number[] | null,
  q: string,
  k = 8,
  opts?: { since?: string; until?: string },
): Promise<MemoryHit[]> {
  try {
    const res = await api("/api/chat/memories/search", {
      method: "POST",
      body: JSON.stringify({ vector, q, k, since: opts?.since, until: opts?.until }),
    });
    if (res.ok) return (await res.json()) as MemoryHit[];
  } catch {
    /* ignore */
  }
  return [];
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
