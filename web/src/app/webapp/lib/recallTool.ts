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
  "conversations with this user across text and voice. A short profile of what you already know about " +
  "this user may be provided above — draw on it naturally so they feel known, but don't recite it. " +
  "If that profile (or a recalled note) records a reminder the user asked you to hold — e.g. \"remind " +
  "me to X when I say 'good morning'\" — honor it: as soon as its trigger or time arrives (for the " +
  "example, the moment the user greets you with 'good morning'), proactively bring the reminder up " +
  "yourself without waiting to be asked. " +
  "For specifics not in that profile, use the recall_memory tool: whenever the user refers to " +
  "something from earlier, asks what you remember, or asks about a past day or topic (pass recent: " +
  "true and omit query for \"what did we talk about today / last time\"). For any question about a " +
  "specific day or period (\"yesterday\", \"last week\", \"on Monday\"), compute the ISO date range " +
  "from the current local date/time you were given and pass it as since/until. Don't reflexively say " +
  "you have no memory — check the profile and call recall_memory first — but never invent a memory " +
  "just to avoid saying you don't have a note: if recall returns nothing, simply say you don't have a " +
  "note on that yet. Only state something as a memory when a note or the profile clearly supports it. " +
  "Never invent memories, details, dates, or who said what, and don't guess. The recalled notes are " +
  "your own — don't claim the user personally told you something unless the note is marked as their " +
  "words (\"You said\"). If a note is unclear or only loosely related, treat it as uncertain: say " +
  "you're not sure or ask rather than asserting. Prefer \"I have a note that…\" over \"you told me…\" " +
  "unless you're certain. " +
  "You cannot delete, edit, or forget individual memories or any stored data yourself — there is no " +
  "tool for that. If the user wants something removed because it's wrong or out of date, you don't " +
  "need to delete anything: invite them to just tell you the correct information, and from then on " +
  "rely on the updated details rather than the old ones. If they still want their data gone, tell " +
  "them the only way to remove it is to delete their account, and that once the account is deleted " +
  "all content associated with it is erased permanently and cannot be recovered. Do not promise to " +
  "delete anything yourself.";

export const RECALL_MEMORY_DECLARATION: FunctionDeclaration = {
  name: "recall_memory",
  description:
    "Search your saved memory of past conversations with this user. Pass `query` for a topic; " +
    "pass `recent: true` (and omit query) for general 'what did we talk about today/last time'; " +
    "pass `since`/`until` to limit results to a specific day or period.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Topic or keywords to search for." },
      recent: { type: Type.BOOLEAN, description: "Return the newest turns regardless of topic." },
      since: {
        type: Type.STRING,
        description:
          "ISO-8601 start (inclusive) of a date range. For date-scoped questions like 'yesterday' or " +
          "'last week', compute this from the current local date/time you were given (e.g. for " +
          "'yesterday', set since to yesterday 00:00 in the user's timezone).",
      },
      until: {
        type: Type.STRING,
        description:
          "ISO-8601 end (exclusive) of a date range (e.g. for 'yesterday', set until to today 00:00 " +
          "in the user's timezone).",
      },
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
  const since = typeof args.since === "string" && args.since.trim() ? args.since.trim() : undefined;
  const until = typeof args.until === "string" && args.until.trim() ? args.until.trim() : undefined;
  const ranged = !!(since || until);
  // A date window can hold a whole busy day, so pull more before truncating (backend clamps to 50).
  const limit = Math.min(Math.max(Number(args.limit) || (ranged ? 30 : 8), 1), 50);

  // The date range (if any) is a time filter applied independently of ranking: with a query we still
  // rank by semantic similarity within the window; without one we fall back to newest-first (vector
  // null, q="") — the endpoint returns recent turns, optionally bounded by since/until.
  const qv = recent || !query ? null : await embedQuery(query);
  const hits = await searchMemories(qv, recent ? "" : query, limit, { since, until });

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
