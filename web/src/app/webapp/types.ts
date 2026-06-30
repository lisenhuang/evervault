export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * "voice" = the user spoke / the assistant has spoken audio attached.
   * "call"  = a centered summary chip logged when a realtime call ends (see `durationSec`).
   */
  kind?: "text" | "voice" | "call";
  /** For kind "call": seconds the user spent on the just-ended realtime call. */
  durationSec?: number;
  /** Spoken reply audio (PCM16 base64) for assistant messages, when produced. */
  audio?: { base64: string; sampleRate: number } | null;
  /** True while the assistant message is still streaming in. */
  streaming?: boolean;
  error?: boolean;
};
