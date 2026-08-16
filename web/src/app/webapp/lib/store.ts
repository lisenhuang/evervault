// Browser-only cache of the /webapp's model choices + voice preference. The app is keyless: Gemini
// calls go through our backend proxy (which holds the pooled keys), so no API key is stored here.
// Models are chosen by the admin and fetched from the server on load; these getters just cache the
// last-known values (and safe defaults) so the UI has something before that fetch resolves.

import { normalizeStyle, type ResponseStyle, type StyleSurface } from "./responseStyle";
// Type-only: erased at compile time, so the store keeps no runtime dependency on the Live stack.
import type { LiveReasoning } from "./liveShared";

const TEXT_MODEL = "ev:textModel";
const AUDIO_MODEL = "ev:audioModel";
const LIVE_MODEL = "ev:liveModel";
// Admin-set auto-hang-up window for an idle live call, in seconds ("0" = never). Cached so a call
// started before the config fetch resolves still uses the admin's value rather than the built-in 60s.
const LIVE_IDLE_SEC = "ev:liveIdleSec";
// How the admin wants voice messages answered ("live" = one Gemini Live session, "tts" = the legacy
// synthesis pipeline) and which Gemini Live model to use for the "live" path. Cached so the first
// voice message of a session uses the admin's policy rather than the built-in default.
const VOICE_MODE = "ev:voiceMode";
const VOICE_LIVE_MODEL = "ev:voiceLiveModel";
// Admin-set thinking level for each Gemini Live leg ("" = the model's own default). Cached like the
// models above so a call started before the config fetch resolves still uses the admin's depth.
const LIVE_REASONING = "ev:liveReasoning";
const VOICE_LIVE_REASONING = "ev:voiceLiveReasoning";
const VOICE = "ev:voice";
const MEMORY_ON = "ev:memoryOn";
const NOTICE_SEEN = "ev:memoryNoticeSeen";
// Response-style presets, chosen separately per surface. Default ("default") leaves the built-in tone.
// These are the browser-local cache; the server (chat/settings) is the cross-device source of truth.
const STYLE_TEXT = "ev:styleText";
const STYLE_VOICE = "ev:styleVoice";
const STYLE_LIVE = "ev:styleLive";
// Has this browser's pre-existing local style choices been pushed up to the server yet? Set once, after
// the first SUCCESSFUL settings read, so the local->server migration runs exactly once per browser and a
// stale local value can never resurrect over the server on later loads.
const STYLE_MIGRATED = "ev:styleMigrated";
// Per-surface "unsynced local edit" flags: set when the user picks a style, cleared when its PUT lands.
// On load, a pending surface keeps its local value (and re-pushes) instead of adopting the server's — so a
// pick made while offline isn't silently reverted by a stale server value on the next reload.
const STYLE_PENDING: Record<StyleSurface, string> = {
  text: "ev:stylePendingText",
  voice: "ev:stylePendingVoice",
  live: "ev:stylePendingLive",
};
// The account (email) the style cache currently belongs to. localStorage is per-browser but these prefs
// are per-user, and a session can change without an explicit logout (cookie expiry, then a different user
// signs in). Comparing this to the signed-in user lets us clear the cache on a real account change while
// preserving it across a same-user reload or a transient auth blip.
const STYLE_OWNER = "ev:styleCacheOwner";
// Chat text size: the multiplier behind the A− / % / A+ stepper in the mobile header. Deliberately
// per-BROWSER and never synced to the account (unlike the response styles above): text size is a
// property of the screen, not of the person — 150% on a phone is right, the same value on a 27"
// monitor is absurd — so pushing it up to /api/chat/settings would let one tap on a phone blow up
// the desktop transcript.
const CHAT_SCALE = "ev:chatScale";

export const DEFAULT_TEXT_MODEL = "gemini-flash-lite-latest";
export const DEFAULT_AUDIO_MODEL = "gemini-2.5-flash-preview-tts";
export const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const DEFAULT_VOICE = "Kore";
/** Fallback idle auto-hang-up window (seconds) before the server's config arrives. */
export const DEFAULT_LIVE_IDLE_SEC = 60;

/** How a voice message is answered. "live" = one Gemini Live session (audio + text in one call, with an
 *  automatic fallback to TTS on failure); "tts" = the legacy record→transcribe→reply→synthesize path. */
export type VoiceMode = "live" | "tts";
/** Default before the server's config arrives — Live (the fast path), matching the backend default. */
export const DEFAULT_VOICE_MODE: VoiceMode = "live";
/** Default Live model for voice messages before config arrives (same list as the call). */
export const DEFAULT_VOICE_LIVE_MODEL = DEFAULT_LIVE_MODEL;

/** The Live thinking levels the admin can pick, plus "" for auto (send no thinkingConfig). Re-exported
 *  from liveShared so the store and the Live sockets can never drift on what a valid level is. */
export type { LiveReasoning };

/** The chat text-size ladder, smallest first. 10% steps: fine enough that no tap overshoots. */
export const CHAT_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;
export const DEFAULT_CHAT_SCALE = 1;

function get(key: string): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(key) ?? "";
}
function set(key: string, value: string) {
  if (typeof localStorage === "undefined") return;
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

// Anything that isn't one of the four Live thinking levels collapses to "" (auto). Kept as a local
// literal rather than imported from liveShared so the store keeps no runtime edge into the Live stack.
function normalizeReasoning(v: string): LiveReasoning {
  return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : "";
}

export const store = {
  getTextModel: () => get(TEXT_MODEL) || DEFAULT_TEXT_MODEL,
  setTextModel: (v: string) => set(TEXT_MODEL, v),
  getAudioModel: () => get(AUDIO_MODEL) || DEFAULT_AUDIO_MODEL,
  setAudioModel: (v: string) => set(AUDIO_MODEL, v),
  getLiveModel: () => get(LIVE_MODEL) || DEFAULT_LIVE_MODEL,
  setLiveModel: (v: string) => set(LIVE_MODEL, v),
  // 0 is a meaningful value here ("never hang up"), so an explicit "0" must survive the round trip —
  // hence the isFinite check rather than the `|| default` idiom used for the string settings above.
  getLiveIdleSec: () => {
    const raw = get(LIVE_IDLE_SEC);
    const sec = Number(raw);
    return raw !== "" && Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_LIVE_IDLE_SEC;
  },
  setLiveIdleSec: (v: number) => set(LIVE_IDLE_SEC, String(v)),
  // Voice-message answer mode. Only "tts" is stored explicitly; anything else (incl. the cleared/unset
  // key) reads back as the "live" default — so an untouched install gets the fast path.
  getVoiceMode: (): VoiceMode => (get(VOICE_MODE) === "tts" ? "tts" : "live"),
  setVoiceMode: (v: VoiceMode) => set(VOICE_MODE, v === "tts" ? "tts" : ""),
  getVoiceLiveModel: () => get(VOICE_LIVE_MODEL) || DEFAULT_VOICE_LIVE_MODEL,
  setVoiceLiveModel: (v: string) => set(VOICE_LIVE_MODEL, v),
  // Live thinking levels. Normalized on read as well as write, so a stale key left by an older release
  // (or a hand-edited value) can't reach the Live socket — a level the API rejects fails the whole
  // session at setup, whereas "" just means "send nothing", which is the pre-existing behavior.
  getLiveReasoning: () => normalizeReasoning(get(LIVE_REASONING)),
  setLiveReasoning: (v: string) => set(LIVE_REASONING, normalizeReasoning(v)),
  getVoiceLiveReasoning: () => normalizeReasoning(get(VOICE_LIVE_REASONING)),
  setVoiceLiveReasoning: (v: string) => set(VOICE_LIVE_REASONING, normalizeReasoning(v)),
  // Chat text size. Snapped to a known step rather than merely parsed, so a corrupt or
  // out-of-range value (hand-edited storage, or a ladder that changes in a later release) can
  // never render the transcript at some unusable size — it just falls back to 100%.
  getChatScale: () => {
    const v = Number(get(CHAT_SCALE));
    return (CHAT_SCALE_STEPS as readonly number[]).includes(v) ? v : DEFAULT_CHAT_SCALE;
  },
  setChatScale: (v: number) => set(CHAT_SCALE, v === DEFAULT_CHAT_SCALE ? "" : String(v)),
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
  // Cross-device style sync bookkeeping (see lib/settings.ts).
  getStyleMigrated: () => get(STYLE_MIGRATED) === "1",
  setStyleMigrated: () => set(STYLE_MIGRATED, "1"),
  getStylePending: (s: StyleSurface) => get(STYLE_PENDING[s]) === "1",
  setStylePending: (s: StyleSurface, on: boolean) => set(STYLE_PENDING[s], on ? "1" : ""),
  // Which account (email) the style cache belongs to. Empty until the first sign-in tags it — an empty
  // owner is left alone so a pre-feature local choice survives to be migrated up (see loadSettings).
  getStyleCacheOwner: () => get(STYLE_OWNER),
  setStyleCacheOwner: (email: string) => set(STYLE_OWNER, email),
  // Wipe every per-browser style key + sync flag. Called on logout so the next account signed in on this
  // browser starts clean — localStorage is per-browser but these prefs are per-user, and logout is
  // SPA-only (no reload), so without this one user's cached style could migrate up into another's account.
  clearStyleCache: () => {
    for (const k of [STYLE_TEXT, STYLE_VOICE, STYLE_LIVE, STYLE_MIGRATED, STYLE_PENDING.text, STYLE_PENDING.voice, STYLE_PENDING.live]) set(k, "");
  },
};
