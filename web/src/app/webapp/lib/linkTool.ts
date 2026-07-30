// The `send_link` tool — puts a tappable link into the chat.
//
// Why this needs to exist at all: in a spoken reply the assistant's TEXT is the transcription of its
// AUDIO, so there is no way for it to show a URL without also reading that URL out loud, which is
// miserable for anything longer than a domain. Before this tool the persona told the model to "offer to
// send the link" instead — an offer it had no way to honour, so when the user said yes it claimed to have
// posted a card that never existed and the link was simply lost.
//
// This posts a SEPARATE assistant message carrying the URL, which MessageList renders through
// react-markdown + remark-gfm (GFM autolinks bare URLs, and the `a` renderer opens in a new tab). So the
// spoken sentence can stay short — "I've put the link below" — while the link itself is clickable.
//
// Unlike send_file this is not a confirmation card: a link is inert until tapped, so there is nothing to
// confirm and an extra tap would just be friction.

import { Type, type FunctionDeclaration } from "@google/genai";

/** A link the assistant wants to show. `title` is optional and purely cosmetic. */
export type OutgoingLink = { url: string; title?: string };

export const LINK_PERSONA =
  "When you want to give the user a web address, call send_link and it appears in the chat as a link they " +
  "can tap. This is how you hand over a link when you are SPEAKING: your spoken words are all the user " +
  "gets, and reading a long URL aloud is unpleasant and hard to act on, so call send_link and say in one " +
  "short sentence what it is rather than reciting the address. (In a typed reply you may simply include " +
  "the link inline in your text instead — that is already tappable — so save the tool for when writing " +
  "the address out isn't a good option.) Whenever the user asks you to send, share or give them a link, " +
  "that is a request to actually deliver one: call send_link. " +
  "Never claim you have sent, shared or shown a link unless you actually called send_link and it " +
  "confirmed. If it tells you links can't be shown right now, say plainly that you can't send it and read " +
  "out the site name instead — never describe a card, a pop-up, or anything else appearing on screen when " +
  "nothing did.";

export const SEND_LINK_DECLARATION: FunctionDeclaration = {
  name: "send_link",
  description:
    "Show the user a web link they can tap, as a message in the chat. Use whenever you want to hand them " +
    "a URL — a source you found, a page you read, or a link they asked you to send — instead of reading " +
    "the address aloud.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: {
        type: Type.STRING,
        description: "The full web address, including https://.",
      },
      title: {
        type: Type.STRING,
        description:
          "Short label for the link, e.g. the page or site name. Optional — the address is shown if omitted.",
      },
    },
    required: ["url"],
  },
};

const SEND_LINK_TOOL_NAME = SEND_LINK_DECLARATION.name;
export const isLinkTool = (name: string) => name === SEND_LINK_TOOL_NAME;

/**
 * Execute a `send_link` call. `args` is the model-supplied object (untyped per the SDK), so every field is
 * coerced defensively, and never throws — a throw would break the function-call loop.
 *
 * `onLink` is what actually posts the message. It is OPTIONAL because not every surface has a chat to post
 * into, and when it is absent the tool says so rather than reporting success: the whole point of this tool
 * is that the model stops claiming to have shown things it hasn't.
 */
export async function runSendLinkTool(
  args: Record<string, unknown>,
  onLink?: (link: OutgoingLink) => void,
): Promise<string> {
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  if (!raw) return JSON.stringify({ error: "a url is required" });

  const url = normalize(raw);
  if (!url) {
    // Anything that isn't an ordinary web address — including a javascript:/data: URL, which must never
    // reach the renderer as a link.
    return JSON.stringify({ error: "that isn't a web address I can send" });
  }

  if (!onLink) {
    return JSON.stringify({
      note: "links cannot be shown on this surface — tell the user you can't send it and name the site instead",
    });
  }

  const title = typeof args.title === "string" ? args.title.trim() : "";
  onLink({ url, title: title || undefined });
  return JSON.stringify({ sent: true, url, note: "the link is now in the chat for the user to tap" });
}

/** Accept only ordinary http(s) URLs, and return the parsed-and-normalised form. */
function normalize(input: string): string | null {
  // A bare "example.com/x" is a perfectly normal thing for the model to produce; assume https.
  const candidate = input.includes("://") ? input : `https://${input}`;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.includes(".")) return null; // no bare hostnames / "localhost"-shaped junk
  return u.toString();
}

/**
 * Render a link as the markdown for its chat message. The title is only used as link text when it is safe
 * to inline — a title containing brackets, parentheses or a newline would break out of the markdown link
 * and could smuggle arbitrary markup into the bubble, so those fall back to showing the bare URL (which
 * remark-gfm autolinks anyway).
 */
export function linkMarkdown(link: OutgoingLink): string {
  const title = (link.title ?? "").replace(/\s+/g, " ").trim();
  const safeTitle = title.length > 0 && title.length <= 120 && !/[[\]()\\<>]/.test(title);
  return safeTitle ? `[${title}](${link.url})` : link.url;
}
