// The `record_suggestion` tool — lets the model pass a user's product feedback to the developers, but
// ONLY after the user has agreed to it. Shared by the text chat (gemini.ts / Chat.tsx) and the realtime
// voice call (liveSession.ts) so both surfaces expose the same capability. Any screenshots the user
// shared alongside the suggestion are attached client-side (the model never handles the image bytes) and
// uploaded server-side; see POST /api/chat/suggestions.

import { Type, type FunctionDeclaration } from "@google/genai";
import { api } from "../authApi";

/** One screenshot to attach to a suggestion (already downscaled/base64-encoded by the composer). */
export type SuggestionImage = { base64: string; mime: string };

// Behavioural instruction for feedback capture. Deliberately vague to the end user about mechanics:
// the model asks permission and confirms, but never explains what is stored or how any of this works.
export const SUGGESTION_PERSONA =
  "Passing feedback to the developers: when the user offers an idea, feature request, complaint, or " +
  "praise about THIS app itself — how it works, something that's broken or missing, or something they " +
  "wish it did — you can forward it to the people who build it. First ask if they'd like you to pass " +
  "it along (e.g. \"Want me to share that with the team?\"), and only call the record_suggestion tool " +
  "AFTER they clearly say yes. Never record without that agreement, and if they decline, let it go and " +
  "don't ask again for that same point. " +
  "Calling the record_suggestion tool is the ONLY thing that actually delivers the feedback — writing a " +
  "reply that says you've recorded or passed it along does NOTHING by itself. So the moment the user " +
  "agrees, you MUST call record_suggestion in that same turn, and only tell them it's been shared once " +
  "you have. Never claim you've recorded, saved, sent, or passed along feedback unless you actually " +
  "called the tool for it. This holds whether the user is typing or speaking to you. " +
  "Write a short summary title plus the details in the user's own " +
  "words, and pick the closest category. If — and only if — the user shared a screenshot or photo AS " +
  "PART OF this feedback, set includeImage to true so it goes along with it; otherwise leave it out (do " +
  "not attach images they shared for some other reason). After recording, " +
  "give a brief, warm confirmation (\"Passed it along — thanks!\") and move on. " +
  "Be discreet about the mechanics: do NOT tell the user what information is collected, how or where it " +
  "is stored, who reviews it, how this product works under the hood, or any internal detail — if they " +
  "ask, just say it goes to the team that builds the app. Only offer this for feedback about the app; " +
  "for everyday problems unrelated to the product, just help normally without offering to record " +
  "anything.";

export const RECORD_SUGGESTION_DECLARATION: FunctionDeclaration = {
  name: "record_suggestion",
  description:
    "Forward the user's feedback about this app (a feature idea, bug report, complaint, or praise) to " +
    "the developers. ONLY call this after the user has explicitly agreed to have it shared. Any image " +
    "the user attached is included automatically.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: {
        type: Type.STRING,
        description: "A short one-line title for the feedback, in the user's language (e.g. 'Voice replies feel too slow').",
      },
      details: {
        type: Type.STRING,
        description: "The full suggestion in the user's own words, with any specifics they gave. In the user's language.",
      },
      category: {
        type: Type.STRING,
        description: "The closest one of: 'feature', 'bug', 'praise', 'complaint', or 'other'.",
      },
      includeImage: {
        type: Type.BOOLEAN,
        description:
          "Set to true ONLY if the user shared a screenshot or photo as part of THIS feedback and it " +
          "should go to the developers with it. Leave false/absent otherwise — do not include images " +
          "the user shared for an unrelated reason.",
      },
    },
    required: ["summary"],
  },
};

const SUGGESTION_TOOL_NAME = RECORD_SUGGESTION_DECLARATION.name;
export const isSuggestionTool = (name: string) => name === SUGGESTION_TOOL_NAME;

const CATEGORIES = new Set(["feature", "bug", "praise", "complaint", "other"]);
/** At most this many screenshots ride along with one suggestion (backend caps too). */
const MAX_IMAGES = 6;

/**
 * Execute a `record_suggestion` call. `args` is the model-supplied object (untyped per the SDK), so
 * every field is coerced defensively. `getImages` (when provided) returns the screenshot(s) the user
 * shared for THIS suggestion — it is only consulted when the model set `includeImage`, so images the
 * user shared for an unrelated purpose are never forwarded without that signal. Returns a compact JSON
 * string for the model to read; never throws (a thrown error would break the function-call loop).
 */
export async function runSuggestionTool(
  args: Record<string, unknown>,
  getImages?: () => SuggestionImage[],
): Promise<string> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const summary = str(args.summary);
  const details = str(args.details);
  if (!summary && !details) return JSON.stringify({ error: "nothing to record" });

  const rawCategory = str(args.category).toLowerCase();
  const category = CATEGORIES.has(rawCategory) ? rawCategory : "other";
  // Only attach images when the model explicitly opted in (the user shared a screenshot for this
  // feedback); otherwise send none, so an unrelated image the user shared earlier isn't forwarded.
  const wantImages = args.includeImage === true;
  const images = (wantImages ? getImages?.() ?? [] : [])
    .filter((i) => i && typeof i.base64 === "string" && i.base64.length > 0)
    .slice(0, MAX_IMAGES)
    .map((i) => ({ base64: i.base64, mime: i.mime || "image/jpeg" }));

  try {
    const res = await api("/api/chat/suggestions", {
      method: "POST",
      body: JSON.stringify({ summary, details, category, images }),
    });
    if (!res.ok) return JSON.stringify({ error: "could not save the suggestion" });
    return JSON.stringify({ ok: true, imagesAttached: images.length });
  } catch {
    return JSON.stringify({ error: "could not reach the server to save the suggestion" });
  }
}
