import type { PreparedFile } from "./lib/files";

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
   */
  kind?: "text" | "voice" | "image" | "call";
  /** For kind "call": seconds the user spent on the just-ended realtime call. */
  durationSec?: number;
  /** Spoken reply audio (PCM16 base64) for assistant messages, when produced. */
  audio?: { base64: string; sampleRate: number } | null;
  /**
   * True while a spoken (voice) reply is withholding its text until its audio is ready: the bubble
   * keeps showing the "typing" dots even though `text` has already streamed in. Cleared once the
   * audio lands (text reveals + auto-plays) or TTS fails (text reveals without audio).
   */
  pendingAudio?: boolean;
  /** Attached files (images, PDFs, extracted documents) for user messages. */
  files?: PreparedFile[] | null;
  /** The earlier message this one replies to (set on user messages sent via "Reply"). */
  replyTo?: ReplyRef | null;
  /** True while the assistant message is still streaming in. */
  streaming?: boolean;
  error?: boolean;
};
