// Browser-only storage for the user's Bring-Your-Own-Key Gemini key and model choices.
// The API key lives ONLY here (localStorage) and is sent only to Google — never to our server.

const KEY = "ev:geminiKey";
const TEXT_MODEL = "ev:textModel";
const AUDIO_MODEL = "ev:audioModel";
const VOICE = "ev:voice";

export const DEFAULT_TEXT_MODEL = "gemini-2.5-flash";
export const DEFAULT_AUDIO_MODEL = "gemini-2.5-flash-preview-tts";
export const DEFAULT_VOICE = "Kore";

function get(key: string): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(key) ?? "";
}
function set(key: string, value: string) {
  if (typeof localStorage === "undefined") return;
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

export const store = {
  getKey: () => get(KEY),
  setKey: (v: string) => set(KEY, v.trim()),
  getTextModel: () => get(TEXT_MODEL) || DEFAULT_TEXT_MODEL,
  setTextModel: (v: string) => set(TEXT_MODEL, v),
  getAudioModel: () => get(AUDIO_MODEL) || DEFAULT_AUDIO_MODEL,
  setAudioModel: (v: string) => set(AUDIO_MODEL, v),
  getVoice: () => get(VOICE) || DEFAULT_VOICE,
  setVoice: (v: string) => set(VOICE, v),
};
