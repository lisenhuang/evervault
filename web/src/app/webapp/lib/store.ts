// Browser-only cache of the /webapp's model choices + voice preference. The app is keyless: Gemini
// calls go through our backend proxy (which holds the pooled keys), so no API key is stored here.
// Models are chosen by the admin and fetched from the server on load; these getters just cache the
// last-known values (and safe defaults) so the UI has something before that fetch resolves.

import { normalizeStyle, type ResponseStyle } from "./responseStyle";

const TEXT_MODEL = "ev:textModel";
const AUDIO_MODEL = "ev:audioModel";
const LIVE_MODEL = "ev:liveModel";
const VOICE = "ev:voice";
const MEMORY_ON = "ev:memoryOn";
const NOTICE_SEEN = "ev:memoryNoticeSeen";
// Response-style presets, chosen separately per surface. Default ("default") leaves the built-in tone.
const STYLE_TEXT = "ev:styleText";
const STYLE_VOICE = "ev:styleVoice";
const STYLE_LIVE = "ev:styleLive";

export const DEFAULT_TEXT_MODEL = "gemini-flash-lite-latest";
export const DEFAULT_AUDIO_MODEL = "gemini-2.5-flash-preview-tts";
export const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";
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
  getTextModel: () => get(TEXT_MODEL) || DEFAULT_TEXT_MODEL,
  setTextModel: (v: string) => set(TEXT_MODEL, v),
  getAudioModel: () => get(AUDIO_MODEL) || DEFAULT_AUDIO_MODEL,
  setAudioModel: (v: string) => set(AUDIO_MODEL, v),
  getLiveModel: () => get(LIVE_MODEL) || DEFAULT_LIVE_MODEL,
  setLiveModel: (v: string) => set(LIVE_MODEL, v),
  getVoice: () => get(VOICE) || DEFAULT_VOICE,
  setVoice: (v: string) => set(VOICE, v),
  // Whether the user has explicitly picked a voice — so the admin's default only applies before they do.
  getVoiceChosen: () => !!get(VOICE),
  // Memory recall is on by default; users can turn it off.
  getMemoryOn: () => get(MEMORY_ON) !== "0",
  setMemoryOn: (on: boolean) => set(MEMORY_ON, on ? "1" : "0"),
  getNoticeSeen: () => get(NOTICE_SEEN) === "1",
  setNoticeSeen: () => set(NOTICE_SEEN, "1"),
  // Per-surface response style. Stored only when non-default (set() clears the key for "default"),
  // so an untouched preference reads back as "default" — the intended zero-config baseline.
  getTextStyle: (): ResponseStyle => normalizeStyle(get(STYLE_TEXT)),
  setTextStyle: (v: ResponseStyle) => set(STYLE_TEXT, v === "default" ? "" : v),
  getVoiceStyle: (): ResponseStyle => normalizeStyle(get(STYLE_VOICE)),
  setVoiceStyle: (v: ResponseStyle) => set(STYLE_VOICE, v === "default" ? "" : v),
  getLiveStyle: (): ResponseStyle => normalizeStyle(get(STYLE_LIVE)),
  setLiveStyle: (v: ResponseStyle) => set(STYLE_LIVE, v === "default" ? "" : v),
};
