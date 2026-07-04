// Persisted per-user preferences (model choices, voice, memory toggle). NO API key — the app uses the
// system Gemini keys via the backend, so there is nothing secret here. Backed by AsyncStorage. Values
// are cached in-memory after a one-time hydrate so the synchronous getters used across the UI work.

import AsyncStorage from "@react-native-async-storage/async-storage";

const TEXT_MODEL = "ev:textModel";
const AUDIO_MODEL = "ev:audioModel";
const LIVE_MODEL = "ev:liveModel";
const VOICE = "ev:voice";
const MEMORY_ON = "ev:memoryOn";
const HEADPHONES = "ev:headphones";

export const DEFAULT_TEXT_MODEL = "gemini-flash-lite-latest";
export const DEFAULT_AUDIO_MODEL = "gemini-3.1-flash-tts-preview";
export const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const DEFAULT_VOICE = "Kore";

const cache: Record<string, string> = {};

/** Load all prefs into the in-memory cache once at startup (before rendering the chat). */
export async function hydrateStore(): Promise<void> {
  const keys = [TEXT_MODEL, AUDIO_MODEL, LIVE_MODEL, VOICE, MEMORY_ON, HEADPHONES];
  try {
    const pairs = await AsyncStorage.multiGet(keys);
    for (const [k, v] of pairs) if (v != null) cache[k] = v;
  } catch {
    /* first run / storage unavailable — defaults apply */
  }
}

function set(key: string, value: string) {
  if (value) cache[key] = value;
  else delete cache[key];
  void AsyncStorage.setItem(key, value).catch(() => {});
}

export const store = {
  getTextModel: () => cache[TEXT_MODEL] || DEFAULT_TEXT_MODEL,
  setTextModel: (v: string) => set(TEXT_MODEL, v),
  getAudioModel: () => cache[AUDIO_MODEL] || DEFAULT_AUDIO_MODEL,
  setAudioModel: (v: string) => set(AUDIO_MODEL, v),
  getLiveModel: () => cache[LIVE_MODEL] || DEFAULT_LIVE_MODEL,
  setLiveModel: (v: string) => set(LIVE_MODEL, v),
  getVoice: () => cache[VOICE] || DEFAULT_VOICE,
  setVoice: (v: string) => set(VOICE, v),
  getMemoryOn: () => cache[MEMORY_ON] !== "0",
  setMemoryOn: (on: boolean) => set(MEMORY_ON, on ? "1" : "0"),
  getHeadphones: () => cache[HEADPHONES] === "1",
  setHeadphones: (on: boolean) => set(HEADPHONES, on ? "1" : "0"),
};
