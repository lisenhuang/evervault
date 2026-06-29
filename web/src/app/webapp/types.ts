export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** "voice" = the user spoke / the assistant has spoken audio attached. */
  kind?: "text" | "voice";
  /** Spoken reply audio (PCM16 base64) for assistant messages, when produced. */
  audio?: { base64: string; sampleRate: number } | null;
  /** True while the assistant message is still streaming in. */
  streaming?: boolean;
  error?: boolean;
};
