// Response-style presets. The user can pick, separately for each surface — text replies, spoken
// voice replies, and live voice calls — how EverVault should sound. Each preset maps to a short
// system-prompt directive appended to that surface's instruction. "default" carries NO directive:
// it leaves the surface's built-in behavior untouched. Most people won't touch this, so "default"
// is the default choice everywhere and simply means "however the app already talks".

export type ResponseStyle =
  | "default"
  | "concise"
  | "friendly"
  | "detailed"
  | "professional"
  | "playful";

// Surfaces a style can be set for. Kept as a type so callers stay honest about which one they mean.
export type StyleSurface = "text" | "voice" | "live";

// Ordered for display — "default" first so it reads as the recommended, leave-it-alone option.
export const RESPONSE_STYLES: readonly ResponseStyle[] = [
  "default",
  "concise",
  "friendly",
  "detailed",
  "professional",
  "playful",
] as const;

export const DEFAULT_STYLE: ResponseStyle = "default";

// Coerce an arbitrary stored string back into a known style, falling back to "default". Guards the
// localStorage read so a stale/garbage value can never break the prompt or the picker UI.
export function normalizeStyle(value: string | null | undefined): ResponseStyle {
  return (RESPONSE_STYLES as readonly string[]).includes(value ?? "")
    ? (value as ResponseStyle)
    : DEFAULT_STYLE;
}

// The system-prompt directive for a style. Empty string for "default" so nothing is injected and the
// surface's own baseline persona wins. Written to read well on any surface (text or spoken).
export function styleDirective(style: ResponseStyle): string {
  switch (style) {
    case "concise":
      return "Keep your replies concise and to the point — a sentence or two when that covers it. Skip preamble, filler, and restating the question; lead with the answer.";
    case "friendly":
      return "Keep a warm, friendly, encouraging tone — approachable and personable, like a supportive friend — while still being genuinely helpful.";
    case "detailed":
      return "Be thorough and detailed. Explain your reasoning, include the relevant context, and anticipate the obvious follow-up questions — err toward completeness over brevity.";
    case "professional":
      return "Keep a professional, polished tone: clear, precise, and businesslike. Avoid slang and overly casual phrasing.";
    case "playful":
      return "Keep a light, playful, upbeat tone. A little humor and personality are welcome, as long as the reply stays genuinely helpful.";
    default:
      return "";
  }
}
