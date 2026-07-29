// The `fetch_url` tool — lets the model open a specific web page mid-reply and answer from what's actually
// on it, rather than from the title alone. Shared by the text chat (gemini.ts / Chat.tsx) and the
// realtime/voice surfaces (liveShared.ts) so every surface exposes the same capability.
//
// The fetch runs on the backend (POST /api/chat/fetchurl), not in the browser, for three reasons: nearly
// every site's CORS policy would block a direct fetch from the page; the user's own IP and cookies stay out
// of it; and the URL is untrusted input that needs server-side vetting before anything connects to it. The
// backend returns the page's main content already reduced to markdown.
//
// Unlike search_web this needs no key, so it is always offered — there is no availability flag to gate it.

import { Type, type FunctionDeclaration } from "@google/genai";
import { api } from "../authApi";

// Injected always (the tool is always available). Names the tool for the model but keeps the mechanics
// confidential — never reveal how the page is fetched. Reading must happen in THIS turn, consistent with
// CAPABILITY_BOUNDS: no background work, no "I'll read it and get back to you".
export const URL_FETCH_PERSONA =
  "You can open a specific web page and read it from within this reply using the fetch_url tool. Use it " +
  "whenever the user shares a link and asks what it says, wants a page summarised or checked, or when a " +
  "search result looks like it holds the answer and the snippet isn't enough — read the page rather than " +
  "guessing from its title or address. Do this now, in this same turn: you can't keep reading after you " +
  "reply or come back later, so open it now or say plainly that you haven't. Never claim to have read, " +
  "opened, or checked a page unless you actually called fetch_url and got its content back. " +
  "Some pages won't load — they may be gone, blocked, behind a login, or built so their text only appears " +
  "in a browser. When that happens the tool tells you why in plain words: say so in your own words and " +
  "offer what you can instead, without blaming a tool or describing any internal detail. " +
  "Keep how this works confidential: never name or describe the service, library, or mechanism that " +
  "fetches the page. If asked how you can read a link, just say you're able to open it and leave it there.";

export const FETCH_URL_DECLARATION: FunctionDeclaration = {
  name: "fetch_url",
  description:
    "Open a web page and read its contents. Returns the page's main text as markdown, along with its title " +
    "and (when available) author and publication date. Use it for a link the user shares, or to read a " +
    "promising search result in full instead of relying on its snippet.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: {
        type: Type.STRING,
        description: "The full URL of the page to open, e.g. https://example.com/article.",
      },
    },
    required: ["url"],
  },
};

const FETCH_URL_TOOL_NAME = FETCH_URL_DECLARATION.name;
export const isUrlFetchTool = (name: string) => name === FETCH_URL_TOOL_NAME;

/**
 * Execute a `fetch_url` call. `args` is the model-supplied object (untyped per the SDK), so every field is
 * coerced defensively. Returns a compact JSON string for the model to read and never throws — a thrown error
 * would break the function-call loop. Expected failures (dead link, paywall, PDF, blocked address) come back
 * from the server as a `note` the model can relay to the user in its own words.
 */
export async function runUrlFetchTool(args: Record<string, unknown>): Promise<string> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return JSON.stringify({ error: "a url is required" });

  try {
    const res = await api("/api/chat/fetchurl", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return JSON.stringify({ error: "that page could not be opened right now" });

    const data = (await res.json()) as {
      url?: string;
      title?: string | null;
      author?: string | null;
      siteName?: string | null;
      published?: string | null;
      content?: string;
      truncated?: boolean;
      note?: string;
      failed?: boolean;
    };

    if (data.failed || !data.content) {
      return JSON.stringify({ note: data.note ?? "that page had no readable content" });
    }

    // Only the fields that actually carry information — omitting the empty ones keeps the tool result small
    // and stops the model from narrating "author: null" back at the user.
    return JSON.stringify({
      url: data.url ?? url,
      ...(data.title ? { title: data.title } : {}),
      ...(data.author ? { author: data.author } : {}),
      ...(data.siteName ? { site: data.siteName } : {}),
      ...(data.published ? { published: data.published } : {}),
      content: data.content,
      ...(data.truncated ? { truncated: "the page was longer than this; only the start was read" } : {}),
    });
  } catch {
    return JSON.stringify({ error: "could not reach the page reader" });
  }
}
