// Browser-only cache of the /webapp's model choices + voice preference. The app is keyless: Gemini
// calls go through our backend proxy (which holds the pooled keys), so no API key is stored here.
// Models are chosen by the admin and fetched from the server on load; these getters just cache the
// last-known values (and safe defaults) so the UI has something before that fetch resolves.

import { normalizeStyle, type ResponseStyle, type StyleSurface } from "./responseStyle";
// liveThinking is a leaf module (no SDK import), so this costs the store nothing at runtime.
import { type LiveReasoning, normalizeLiveReasoning } from "./liveThinking";

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
// Desktop layout of the left rail: how wide it is, and whether it is currently hidden. Per-BROWSER
// for the same reason as the text size above — how much of a window you can spare for a nav rail is a
// property of the screen in front of you, not of the person. A 27" monitor and a 13" laptop signed into
// one account want different answers, and syncing would make each one keep overwriting the other.
const SIDEBAR_WIDTH = "ev:sidebarWidth";
const SIDEBAR_HIDDEN = "ev:sidebarHidden";

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

/**
 * Desktop rail width, in px. The default is the 240px (`w-60`) the rail shipped with, so an install
 * that never touches the handle looks exactly as it did. The floor is the narrowest a conversation
 * title stays readable at; the ceiling stops the rail from turning into the main event.
 *
 * The three are deliberately on ONE 16px grid — 208 = 240 − 2×16, 480 = 240 + 15×16 — because the
 * arrow keys step by 16 from wherever they start. Off-grid bounds would put the default out of
 * reach from the keyboard entirely (200 → 216 → 232 → 248 steps straight over 240), leaving
 * double-click, a pointer-only gesture, as the only way back to it.
 */
export const DEFAULT_SIDEBAR_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 480;

/**
 * The widest the rail may be **in the window it is currently in**: never more than half of it, so
 * the transcript always keeps the larger share however small the window gets.
 *
 * This is a rendering cap, not a preference, and CSS enforces it on its own as
 * `min(var(--rail), 50vw)` — which is what makes a window resized *after the fact* correct with no
 * listener. The number is needed here only while the user is actively dragging or stepping, where
 * the rail has to stop exactly under the cursor rather than under a value CSS is about to cap.
 */
export function maxSidebarWidth(): number {
  const half = typeof window === "undefined" ? SIDEBAR_MAX_WIDTH : Math.round(window.innerWidth / 2);
  // max() before min(): below ~416px half the window is under the floor, and a max that sits under
  // the min would invert the clamp and pin the rail to the ceiling instead.
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, half));
}

/**
 * Snap a candidate width into the range that may be *stored*.
 *
 * Deliberately NOT window-aware. The stored number is the user's preference, and the window they
 * happen to have open today is not a reason to rewrite it: clamping on read would quietly turn the
 * 480 chosen on a 27" monitor into 400 the first time the same profile opened an 800px window, and
 * the next drag would then persist that 400 for good. CSS caps what is *drawn*; this caps only what
 * is meaningful to remember.
 */
export function clampSidebarWidth(px: number): number {
  const candidate = Number.isFinite(px) ? px : DEFAULT_SIDEBAR_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(candidate)));
}

/** Snap a candidate width to what can actually be shown right now — the storage clamp, then the
 *  window's half-width cap. Used while dragging and stepping, so the edge lands under the cursor. */
export function clampSidebarWidthToViewport(px: number): number {
  return Math.min(maxSidebarWidth(), clampSidebarWidth(px));
}

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
  getLiveReasoning: () => normalizeLiveReasoning(get(LIVE_REASONING)),
  setLiveReasoning: (v: string) => set(LIVE_REASONING, normalizeLiveReasoning(v)),
  getVoiceLiveReasoning: () => normalizeLiveReasoning(get(VOICE_LIVE_REASONING)),
  setVoiceLiveReasoning: (v: string) => set(VOICE_LIVE_REASONING, normalizeLiveReasoning(v)),
  // Chat text size. Snapped to a known step rather than merely parsed, so a corrupt or
  // out-of-range value (hand-edited storage, or a ladder that changes in a later release) can
  // never render the transcript at some unusable size — it just falls back to 100%.
  getChatScale: () => {
    const v = Number(get(CHAT_SCALE));
    return (CHAT_SCALE_STEPS as readonly number[]).includes(v) ? v : DEFAULT_CHAT_SCALE;
  },
  setChatScale: (v: number) => set(CHAT_SCALE, v === DEFAULT_CHAT_SCALE ? "" : String(v)),
  // Desktop rail width. Clamped on read as well as write, but only against the fixed bounds — see
  // clampSidebarWidth on why the current window deliberately does not get a say in what is stored.
  // The `|| DEFAULT` is on the RAW string, deliberately: an absent key reads back as "", and
  // Number("") is 0 — a perfectly finite number that would clamp to the minimum and silently
  // narrow the rail of every install that has never touched the handle.
  getSidebarWidth: () => clampSidebarWidth(Number(get(SIDEBAR_WIDTH) || DEFAULT_SIDEBAR_WIDTH)),
  setSidebarWidth: (v: number) => {
    const px = clampSidebarWidth(v);
    set(SIDEBAR_WIDTH, px === DEFAULT_SIDEBAR_WIDTH ? "" : String(px));
  },
  // Whether the desktop rail is hidden. Only "1" is stored, so an untouched install (and a cleared
  // key) reads back as "showing" — the pre-existing behaviour.
  getSidebarHidden: () => get(SIDEBAR_HIDDEN) === "1",
  setSidebarHidden: (v: boolean) => set(SIDEBAR_HIDDEN, v ? "1" : ""),
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
