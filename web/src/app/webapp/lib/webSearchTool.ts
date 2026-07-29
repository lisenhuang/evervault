// The `search_web` tool — lets the model look things up on the live web mid-reply (current events,
// prices, schedules, facts that may have changed). Shared by the text chat (gemini.ts / Chat.tsx) and
// the realtime/voice surfaces (liveShared.ts) so every surface exposes the same capability. Credentials
// live only on the backend; the browser just posts a query to POST /api/chat/websearch and relays the
// results to the model. Which provider actually served the query is a backend concern the client never
// sees — it tries a dedicated search API first and falls back to a grounded model search when that one is
// rate-limited or unconfigured. Availability is gated by the `webSearch` flag on GET /api/chat/ai/config —
// the tool is only offered (and SEARCH_PERSONA_AVAILABLE injected) when some provider can serve it;
// otherwise SEARCH_PERSONA_UNAVAILABLE tells the model it can't browse.

import { Type, type FunctionDeclaration } from "@google/genai";
import { api } from "../authApi";

// Injected when web search IS available. Names the tool for the model (as SUGGESTION_PERSONA does with
// record_suggestion) but keeps the mechanics confidential to the user — never reveal the engine/provider
// or that a key is involved. Search must happen in THIS turn (consistent with CAPABILITY_BOUNDS: no
// background/after-reply work).
export const SEARCH_PERSONA_AVAILABLE =
  "You can look things up on the live web from within this reply using the search_web tool. When the " +
  "user asks about current events, recent or fast-changing facts, live prices or schedules, or anything " +
  "you're unsure of or that may be out of date, call search_web and answer from what it returns, weaving " +
  "in the specifics that matter. Do this now, in this same turn: as with everything else, you can't keep " +
  "researching after you reply or come back later with results — so look it up now, or answer from what " +
  "you already know, and never promise to go find something afterward. Never say you searched, checked, " +
  "or found something online unless you actually called search_web and got results back. " +
  "You may share your sources: most results carry a title and a web address (URL) — those are the " +
  "found page's own public links, not an internal detail, so it's fine to include them, and you SHOULD " +
  "give the relevant one(s) whenever the user asks for a link, a source, or where something came from. " +
  "Some results are a plain summary with no URL; use them for the facts, but don't invent a link for one " +
  "or present it as a page you can point the user to. " +
  "Because tool results aren't kept once the turn ends, include or offer the source link in the SAME " +
  "reply where you use a result (so the user doesn't have to make you look it up again just to get the " +
  "link) — e.g. when you mention a news item, add its link or offer to. In a spoken reply, long URLs are " +
  "awkward to read aloud, so name the site and offer to send the link rather than reciting it. " +
  "Keep how this works confidential: never name, describe, or hint at the search engine, provider, or " +
  "any tool, key, or service you use to search — that's separate from the addresses of the pages you " +
  "found, which you can share. If the user asks HOW you can browse, just say you're able to look things " +
  "up for them and leave it there.";

// Injected when web search is NOT available. Must never explain WHY (no key/setting/provider/config).
// Scoped carefully to SEARCHING: opening a specific URL is a separate, always-available capability
// (fetch_url), and this text sits in the same system instruction as URL_FETCH_PERSONA. A blanket "you
// cannot open a link" here would flatly contradict that and leave the model refusing to read a link the
// user just pasted.
export const SEARCH_PERSONA_UNAVAILABLE =
  "You cannot run a web SEARCH right now, so you can't go looking for pages or discover what's out there " +
  "on a topic, and you have no general access to up-to-the-minute information beyond what you already " +
  "know and what's in this conversation. Don't claim to search the web, look something up online, or " +
  "check what's being reported, and don't promise to find current information. If the user asks for " +
  "something that would need a search — breaking news, today's prices, who's saying what about a topic — " +
  "say plainly that you can't look it up for them right now, and offer what you can from what you already " +
  "know instead. This limit is about SEARCHING only: if the user gives you a specific web address, you " +
  "can still open that page and read it, so do that rather than saying you can't. Never explain why you " +
  "can't search: don't mention a key, a setting, a configuration, a provider, or any other internal " +
  "detail — only that searching the web isn't something you're able to do at the moment.";

export const SEARCH_WEB_DECLARATION: FunctionDeclaration = {
  name: "search_web",
  description:
    "Search the live web for current, real-world information (news, prices, schedules, or any fact that " +
    "may have changed since your knowledge was fixed). Returns a list of result titles, URLs, and " +
    "snippets to answer from. Use it whenever you might be out of date or unsure — don't guess.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: "The search query, phrased for a web search engine, in the user's language.",
      },
      count: {
        type: Type.INTEGER,
        description: "How many results to return (default 5, max 10).",
      },
    },
    required: ["query"],
  },
};

const SEARCH_WEB_TOOL_NAME = SEARCH_WEB_DECLARATION.name;
export const isWebSearchTool = (name: string) => name === SEARCH_WEB_TOOL_NAME;

/**
 * Execute a `search_web` call. `args` is the model-supplied object (untyped per the SDK), so every field
 * is coerced defensively. Posts the query to the backend (which holds the Brave key) and returns a
 * compact JSON string for the model to read; never throws (a thrown error would break the function-call
 * loop). A missing key surfaces server-side as an empty result set with a note, so the model gracefully
 * says it can't search rather than erroring.
 */
export async function runWebSearchTool(args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return JSON.stringify({ error: "a search query is required" });
  const count = Math.min(Math.max(Math.trunc(Number(args.count)) || 5, 1), 10);

  try {
    const res = await api("/api/chat/websearch", {
      method: "POST",
      body: JSON.stringify({ query, count }),
    });
    if (!res.ok) return JSON.stringify({ error: "web search is unavailable right now" });
    const data = (await res.json()) as { results?: unknown; note?: string };
    const results = Array.isArray(data.results) ? data.results.slice(0, count) : [];
    if (results.length === 0) {
      return JSON.stringify({ results: [], note: data.note ?? "no web results found" });
    }
    return JSON.stringify({ results });
  } catch {
    return JSON.stringify({ error: "could not reach the web search service" });
  }
}
