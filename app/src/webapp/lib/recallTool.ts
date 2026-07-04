// The `recall_memory` tool — lets the model search its own stored memory of past conversations. Shared
// by the text chat and the realtime voice call, so both expose the exact same capability.

import { embedQuery } from "./embed";
import type { FunctionDeclaration } from "./genai";
import { Type } from "./genai";
import { searchMemories } from "./recordApi";
import { formatMemoryDate } from "./time";

// Persona + memory-awareness preamble. Without this the model says it has no memory and never calls the
// tool. Prepend it to the per-turn time context on both surfaces.
export const MEMORY_PERSONA =
  "You are EverVault, a personal AI companion with persistent long-term memory of your past " +
  "conversations with this user across text and voice. A short profile of what you already know about " +
  "this user may be provided above — draw on it naturally so they feel known, but don't recite it. " +
  "For specifics not in that profile, use the recall_memory tool: whenever the user refers to " +
  "something from earlier, asks what you remember, or asks about a past day or topic (pass recent: " +
  'true and omit query for "what did we talk about today / last time"). For any question about a ' +
  'specific day or period ("yesterday", "last week", "on Monday"), compute the ISO date range ' +
  "from the current local date/time you were given and pass it as since/until. Never claim you have " +
  "no memory or can't remember — use the profile or call recall_memory first. If recall returns " +
  "nothing, say you don't have a note on that yet. " +
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
          "ISO-8601 start (inclusive) of a date range. For date-scoped questions like 'yesterday', " +
          "compute this from the current local date/time you were given.",
      },
      until: {
        type: Type.STRING,
        description: "ISO-8601 end (exclusive) of a date range (e.g. for 'yesterday', today 00:00 local).",
      },
      limit: { type: Type.INTEGER, description: "Max results to return (default 8)." },
    },
  },
};

/** Execute a `recall_memory` call. Returns a compact JSON string for the model to read. */
export async function runRecallTool(args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const recent = args.recent === true;
  const since = typeof args.since === "string" && args.since.trim() ? args.since.trim() : undefined;
  const until = typeof args.until === "string" && args.until.trim() ? args.until.trim() : undefined;
  const ranged = !!(since || until);
  const limit = Math.min(Math.max(Number(args.limit) || (ranged ? 30 : 8), 1), 50);

  const qv = recent || !query ? null : await embedQuery(query);
  const hits = await searchMemories(qv, recent ? "" : query, limit, { since, until });

  if (hits.length === 0) return JSON.stringify({ memories: [], note: "no matching memories found" });
  return JSON.stringify({
    memories: hits.map((h) => ({
      when: formatMemoryDate(h.createdAt),
      role: h.role,
      modality: h.modality,
      text: h.content.length > 500 ? h.content.slice(0, 500) + "…" : h.content,
    })),
  });
}
