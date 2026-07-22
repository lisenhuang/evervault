// The file tools — let the model find files the user sent it in the past and hand one back. Shared by
// the text chat (gemini.ts / Chat.tsx) and the realtime voice call (liveSession.ts) so both surfaces
// expose the same capability. Reuses the /api/chat/files endpoints via filesApi.ts; no new network
// code. `send_file` deliberately does NOT deliver anything on its own — it posts a confirmation card
// into the chat which the user has to accept, so the file only ever leaves storage on a human action.
// The model-facing strings below describe that card by what it does and never quote its button copy:
// the card is localized (en/zh/ja/ko), so naming the English label would have the model tell a
// Japanese user to tap a word their screen doesn't show. That card is chat-only UI, so during a live
// call `send_file` reports back that it isn't available there (find_files still works, so she can say
// she has the file and offer to send it in the text chat).

import { Type, type FunctionDeclaration } from "@google/genai";
import { embedDocument } from "./embed";
import { getChatFile, searchChatFiles, type StoredFileMeta } from "./filesApi";
import { formatLocalWhen } from "./time";

// Persona addendum for stored files. Without this the model falls back on its trained belief that it
// cannot retrieve anything the user sent earlier, and simply never calls find_files. Prepend it
// alongside MEMORY_PERSONA on both surfaces.
export const FILES_PERSONA =
  "Files the user sends you — photos, images, PDFs, audio clips, documents — are kept, and you CAN " +
  "find them again later and give them back. So never tell the user you're unable to retrieve, pull " +
  "up, or resend something they sent you before; that is no longer true. Whenever they ask about, ask " +
  "for, or refer to a file from an earlier conversation (\"that photo I sent you\", \"the invoice\", " +
  "\"resend the recording\", \"what was in that PDF?\"), call the find_files tool first and answer from " +
  "what it returns. Search by what the file is ABOUT (what you described when they sent it) or by its " +
  "file name — either works. For a specific day or period, compute an ISO since/until range from the " +
  "current local date/time you were given. " +
  "Calling the send_file tool is the ONLY thing that can put a file in front of the user — writing a " +
  "reply that says \"here it is\", \"sending it now\", or \"attached\" does NOTHING by itself. So when " +
  "they want a file back, you MUST call send_file in that same turn, and never claim you've sent, " +
  "attached, or resent anything unless you actually called the tool for it. " +
  "send_file does not deliver the file either: it shows a confirmation card in the chat, and the file " +
  "is only handed over once the user accepts it on that card. Never quote or name the card's buttons " +
  "— they are written in the user's own language, so just ask them to confirm and let them find it. " +
  "So say you've FOUND the file and put it there for them to confirm — never that you've already " +
  "sent it. Don't call send_file repeatedly for the same file; the card stays until they act on it. " +
  "When several files match, don't guess: name them briefly (file name and roughly when they were " +
  "sent) and ask which one they mean. The `when` you get for each file is already in the user's local " +
  "time — state it as given and don't recompute the date from any other timestamp. " +
  "If find_files comes back empty, say plainly that you don't have " +
  "it rather than inventing a file, describing one you never saw, or promising to look again later — " +
  "only files the user sent after this ability was added are stored, so genuinely old ones aren't " +
  "there. Refer to files by their name, never by id number, and don't mention tools, storage, search, " +
  "or any other mechanics to the user.";

export const FIND_FILES_DECLARATION: FunctionDeclaration = {
  name: "find_files",
  description:
    "Search the files the user has sent you in past conversations (images, PDFs, audio, documents). " +
    "Use whenever they ask about or ask for something they sent before. Matches both what the file is " +
    "about and its file name. Returns file ids to pass to send_file.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          "What to look for: the subject matter of the file (e.g. 'the receipt from the sushi place', " +
          "'my dog'), or a file name (e.g. 'report_q3.pdf'). Omit to list the newest files.",
      },
      kind: {
        type: Type.STRING,
        description: "Restrict to one type: 'image', 'pdf', 'audio', or 'text'. Omit for all types.",
      },
      since: {
        type: Type.STRING,
        description:
          "ISO-8601 start (inclusive) of a date range. For 'last month' or 'that photo from Tuesday', " +
          "compute this from the current local date/time you were given.",
      },
      until: { type: Type.STRING, description: "ISO-8601 end (exclusive) of a date range." },
      limit: { type: Type.INTEGER, description: "Max files to return (default 5, max 20)." },
    },
  },
};

export const SEND_FILE_DECLARATION: FunctionDeclaration = {
  name: "send_file",
  description:
    "Offer one stored file back to the user. This does NOT send it — it shows a confirmation card in " +
    "the chat which the user has to accept before the file is handed over. Use the id from " +
    "find_files. After calling, tell the user you've found the file and put it there to confirm — " +
    "never say you've already sent it, and never name the card's buttons (they're in the user's own " +
    "language, not yours).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.INTEGER, description: "The file's id, from find_files." },
      note: {
        type: Type.STRING,
        description:
          "Optional one-line message shown on the card, in the user's language (e.g. 'This is the " +
          "invoice you sent in June').",
      },
    },
    required: ["id"],
  },
};

export const FILE_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  FIND_FILES_DECLARATION,
  SEND_FILE_DECLARATION,
];

const FILE_TOOL_NAMES = new Set(FILE_TOOL_DECLARATIONS.map((d) => d.name));
export const isFileTool = (name: string) => FILE_TOOL_NAMES.has(name);

/** How much of a file's description the model gets back per hit — enough to tell two files apart. */
const MaxSummaryChars = 300;

const brief = (m: StoredFileMeta) => ({
  id: m.id,
  name: m.name,
  kind: m.kind,
  size: m.sizeBytes,
  when: formatLocalWhen(m.createdAt),
  summary: m.description.length > MaxSummaryChars ? m.description.slice(0, MaxSummaryChars) + "…" : m.description,
});

/**
 * Execute a file tool call. `args` is the model-supplied object (untyped per the SDK), so every field
 * is coerced defensively. `onOffer` posts the confirmation card into the chat — it is the only way a
 * file reaches the user, and it is absent on surfaces that have no chat UI to tap (the live voice
 * call), where `send_file` therefore reports back that it can't be done there. Returns a compact JSON
 * string for the model to read; never throws (a thrown error would break the function-call loop) —
 * failures come back as a JSON `{ error }` the model can relay.
 */
export async function runFileTool(
  name: string,
  args: Record<string, unknown>,
  onOffer?: (meta: StoredFileMeta, note?: string) => void,
): Promise<string> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  if (name === "find_files") {
    const query = str(args.query) ?? "";
    const kind = str(args.kind)?.toLowerCase();
    const since = str(args.since);
    const until = str(args.until);
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    // Best-effort vector: the descriptions were embedded as documents on upload, so an embedding
    // failure (no policy / offline) just leaves the keyword + trigram lanes to do the work.
    const vector = query ? (await embedDocument(query)) ?? null : null;
    const hits = await searchChatFiles(vector, query, limit, {
      kind: kind === "image" || kind === "pdf" || kind === "audio" || kind === "text" ? kind : undefined,
      since,
      until,
    });
    if (hits.length === 0) return JSON.stringify({ files: [], note: "no stored files matched" });
    return JSON.stringify({ files: hits.map(brief) });
  }

  if (name === "send_file") {
    const id = Number(args.id);
    if (!Number.isFinite(id)) return JSON.stringify({ error: "a file id is required" });
    const meta = await getChatFile(id);
    if (!meta) return JSON.stringify({ error: "no such file" });
    if (!onOffer) {
      return JSON.stringify({
        error:
          "you can tell the user about the file, but it can only be sent in the text chat, not during a call",
      });
    }
    // The declaration advertises `note` as a line shown on the card, so it has to actually reach it —
    // a model that puts its explanation there and keeps its own reply short would otherwise produce a
    // bare card with no clue which of three invoices this is.
    const note = typeof args.note === "string" ? args.note.trim() : "";
    onOffer(meta, note || undefined);
    return JSON.stringify({
      ok: true,
      offered: true,
      note:
        "A confirmation card for this file is now shown in the chat. The file has NOT been sent yet — " +
        "the user must confirm it there. Tell them it's waiting for them to confirm, without naming the " +
        "card's buttons (they're localized); do not claim you already sent it.",
    });
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}
