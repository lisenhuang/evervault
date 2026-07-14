// Single source of truth for Gemini's prebuilt voice metadata (name + character + gender) and the
// shared gender glyph. Kept dependency-light — only lucide-react (a shared web+admin dep), NOT the
// @google/genai SDK — so the admin can reuse this list/icon without pulling the webapp's Gemini bundle.

import { Mars, Venus } from "lucide-react";

/**
 * Gemini's 30 prebuilt TTS/Live voices. `name` is the value sent to the API;
 * `mood` is the characteristic documented at
 * https://ai.google.dev/gemini-api/docs/speech-generation#voices.
 * `gender` is a community classification (Google's table doesn't list it) shown
 * only to help users choose.
 */
export const PREBUILT_VOICES = [
  { name: "Zephyr", mood: "Bright", gender: "Female" },
  { name: "Puck", mood: "Upbeat", gender: "Male" },
  { name: "Charon", mood: "Informative", gender: "Male" },
  { name: "Kore", mood: "Firm", gender: "Female" },
  { name: "Fenrir", mood: "Excitable", gender: "Male" },
  { name: "Leda", mood: "Youthful", gender: "Female" },
  { name: "Orus", mood: "Firm", gender: "Male" },
  { name: "Aoede", mood: "Breezy", gender: "Female" },
  { name: "Callirrhoe", mood: "Easy-going", gender: "Female" },
  { name: "Autonoe", mood: "Bright", gender: "Female" },
  { name: "Enceladus", mood: "Breathy", gender: "Male" },
  { name: "Iapetus", mood: "Clear", gender: "Male" },
  { name: "Umbriel", mood: "Easy-going", gender: "Male" },
  { name: "Algieba", mood: "Smooth", gender: "Male" },
  { name: "Despina", mood: "Smooth", gender: "Female" },
  { name: "Erinome", mood: "Clear", gender: "Female" },
  { name: "Algenib", mood: "Gravelly", gender: "Male" },
  { name: "Rasalgethi", mood: "Informative", gender: "Male" },
  { name: "Laomedeia", mood: "Upbeat", gender: "Female" },
  { name: "Achernar", mood: "Soft", gender: "Female" },
  { name: "Alnilam", mood: "Firm", gender: "Male" },
  { name: "Schedar", mood: "Even", gender: "Male" },
  { name: "Gacrux", mood: "Mature", gender: "Female" },
  { name: "Pulcherrima", mood: "Forward", gender: "Female" },
  { name: "Achird", mood: "Friendly", gender: "Male" },
  { name: "Zubenelgenubi", mood: "Casual", gender: "Male" },
  { name: "Vindemiatrix", mood: "Gentle", gender: "Female" },
  { name: "Sadachbia", mood: "Lively", gender: "Male" },
  { name: "Sadaltager", mood: "Knowledgeable", gender: "Male" },
  { name: "Sulafat", mood: "Warm", gender: "Female" },
] as const;

export type Voice = (typeof PREBUILT_VOICES)[number];

/** Look up a voice's metadata (mood + gender) by its API name; undefined if unknown. */
export function voiceMeta(name: string): Voice | undefined {
  return PREBUILT_VOICES.find((v) => v.name === name);
}

/** Venus/Mars glyph for a voice's gender, shown instead of the word "Male"/"Female". */
export function GenderIcon({ gender, size }: { gender: Voice["gender"]; size: number }) {
  return gender === "Male" ? (
    <Mars size={size} className="shrink-0 text-blue-500 dark:text-blue-400" aria-hidden="true" />
  ) : (
    <Venus size={size} className="shrink-0 text-pink-500 dark:text-pink-400" aria-hidden="true" />
  );
}
