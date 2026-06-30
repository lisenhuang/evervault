// The `recall_memory` tool — lets the model search its own stored memory of past conversations.
// Shared by the text chat (gemini.ts) and the realtime voice call (liveSession.ts) so both surfaces
// expose the exact same capability. Reuses the existing embedding + search helpers; no new network
// code. Vectors/text go through the same /api/chat/memories/search endpoint the auto-recall uses.

import { Type, type FunctionDeclaration } from "@google/genai";
import { embedQuery } from "./embed";
import { searchMemories } from "../recordApi";
import { formatMemoryDate } from "./time";

// Persona + memory-awareness preamble. Without this the model says it has no memory and never calls
// the tool. Prepend it to the per-turn time context on both surfaces.
export const MEMORY_PERSONA =
  "You are EverVault, a personal AI companion with persistent long-term memory of your past " +
  "conversations with this user across text and voice. Use the recall_memory tool whenever the user " +
  "refers to something from earlier, asks what you remember, or asks about a past day or topic " +
  "(pass recent: true and omit query for \"what did we talk about today / last time\"). Never claim " +
  "you have no memory or can't remember — call recall_memory first. If it returns nothing, say you " +
  "don't have a note on that yet.";

export const RECALL_MEMORY_DECLARATION: FunctionDeclaration = {
  name: "recall_memory",
  description:
    "Search your saved memory of past conversations with this user. Pass `query` for a topic; " +
    "pass `recent: true` (and omit query) for general 'what did we talk about today/last time'.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Topic or keywords to search for." },
      recent: { type: Type.BOOLEAN, description: "Return the newest turns regardless of topic." },
      limit: { type: Type.INTEGER, description: "Max results to return (default 8)." },
    },
  },
};

/**
 * Execute a `recall_memory` call. `args` is the model-supplied object (untyped per the SDK), so every
 * field is coerced defensively. Returns a compact JSON string for the model to read.
 */
export async function runRecallTool(args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const recent = args.recent === true;
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);

  // Recency mode (no query / explicit recent): vector=null, q="" → endpoint returns newest-first.
  // Otherwise embed the query for semantic search (endpoint falls back to text match if no vector).
  const qv = recent || !query ? null : await embedQuery(query);
  const hits = await searchMemories(qv, recent ? "" : query, limit);

  if (hits.length === 0) {
    return JSON.stringify({ memories: [], note: "no matching memories found" });
  }
  return JSON.stringify({
    memories: hits.map((h) => ({
      when: formatMemoryDate(h.createdAt),
      role: h.role,
      modality: h.modality,
      text: h.content.length > 500 ? h.content.slice(0, 500) + "…" : h.content,
    })),
  });
}
