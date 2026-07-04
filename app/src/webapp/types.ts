import type { PreparedFile } from "./lib/files";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * "voice" = spoken message / spoken reply attached.
   * "image" = the user attached at least one image (see `files`).
   * "call"  = a centered summary chip logged when a realtime call ends (see `durationSec`).
   */
  kind?: "text" | "voice" | "image" | "call";
  durationSec?: number;
  /** Spoken reply audio (PCM16 base64 + sample rate) for assistant messages, when produced. */
  audio?: { base64: string; sampleRate: number } | null;
  files?: PreparedFile[] | null;
  streaming?: boolean;
  error?: boolean;
};
