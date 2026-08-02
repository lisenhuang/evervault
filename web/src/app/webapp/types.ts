import type { PreparedFile } from "./lib/files";
import type { StoredFileMeta } from "./lib/filesApi";
import type { ForgetItem } from "./lib/forgetTool";

/** Snapshot of the message a reply quotes — enough to render the quote and locate the original. */
export type ReplyRef = {
  id: string;
  role: "user" | "assistant";
  /** Original text at reply time (may be empty for a voice message with no transcript). */
  text: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * "voice" = the user spoke / the assistant has spoken audio attached.
   * "image" = the user attached at least one image (see `files`).
   * "call"  = a centered summary chip logged when a realtime call ends (see `durationSec`).
   * "fileOffer" = a confirmation card the assistant posts when it has found a stored file the user
   *   asked for (see `fileRef`). The file is *not* in the chat yet — it's only sent, replacing this
   *   card with a normal message carrying `files`, once the user confirms on that card.
   * "forgetOffer" = a confirmation card listing what the assistant would remove from memory (see
   *   `forgetRef`). Nothing is deleted until the user accepts it here — the tap IS the deletion, so
   *   the model can never remove anything on its own.
   */
  kind?: "text" | "voice" | "image" | "call" | "fileOffer" | "forgetOffer";
  /**
   * For kind "voice": text the user TYPED and sent together with the clip, when they recorded on top of
   * something already in the composer. `text` on a voice message is what was SPOKEN (the transcript,
   * which lands a moment later), so the two are kept apart rather than concatenated — the bubble shows
   * the typed line above the spoken one, and the model is handed both as one message.
   */
  caption?: string | null;
  /** For kind "call": seconds the user spent on the just-ended realtime call. */
  durationSec?: number;
  /** For kind "fileOffer": the stored file this offer card is for. */
  fileRef?: StoredFileMeta | null;
  /** For kind "forgetOffer": the things that would be removed if the user accepts. */
  forgetRef?: ForgetItem[] | null;
  /** Spoken reply audio (PCM16 base64) for assistant messages, when produced. */
  audio?: { base64: string; sampleRate: number } | null;
  /**
   * True while a spoken (voice) reply is withholding its text until its audio is ready: the bubble
   * keeps showing the "typing" dots even though `text` has already streamed in. Cleared once the
   * audio lands (text reveals + auto-plays) or TTS fails (text reveals without audio).
   */
  pendingAudio?: boolean;
  /** Attached files (images, PDFs, extracted documents): the ones a user message was sent with, or
   *  the stored file the assistant handed back after the user confirmed a "fileOffer" card. */
  files?: PreparedFile[] | null;
  /** The earlier message this one replies to (set on user messages sent via "Reply"). */
  replyTo?: ReplyRef | null;
  /** True while the assistant message is still streaming in. */
  streaming?: boolean;
  error?: boolean;
};

/**
 * Everything a message actually said, as one string. Normally just its text — but a voice message
 * recorded on top of something already typed carries BOTH halves: `caption` is what was typed, `text`
 * what was spoken. Anywhere a message is treated as "what was said" — recall queries, the to-do intent
 * checks, a quoted reply, the durable transcript, Copy — has to read the whole thing, not whichever
 * half happens to live in `text`.
 */
export function messageBodyText(m: Pick<ChatMessage, "text" | "caption">): string {
  return [m.caption, m.text].filter(Boolean).join("\n");
}
