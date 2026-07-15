// Server-side persistence of the /webapp response-style preferences, so a signed-in user's choices
// follow their account across devices/browsers instead of living only in this browser's localStorage.
// Scoped to the ev_user session (same cookie as profile/tasks). Mirrors profile.ts, with ONE deliberate
// difference: getSettings fails DISTINCTLY (returns null, never an all-default object) so the caller can
// tell "the server genuinely has no styles set" from "the read failed" — the load-time reconciliation
// depends on that difference to avoid pushing stale local values over good server data during a rollout.

import { api } from "../authApi";
import { normalizeStyle, type ResponseStyle, type StyleSurface } from "./responseStyle";
import { store } from "./store";

export type Settings = { text: ResponseStyle; voice: ResponseStyle; live: ResponseStyle };
type SettingsWire = { textStyle: string; voiceStyle: string; liveStyle: string };

// Our surface names <-> the wire fields.
const FIELD: Record<StyleSurface, keyof SettingsWire> = { text: "textStyle", voice: "voiceStyle", live: "liveStyle" };

/**
 * The signed-in user's stored styles, or null if the read failed (offline, or a 404 against an older
 * backend during a rollout, or any error). NULL means "couldn't read" — NOT "all default"; the caller
 * must keep its local state and skip the migration on null.
 */
export async function getSettings(): Promise<Settings | null> {
  try {
    const res = await api("/api/chat/settings");
    if (!res.ok) return null;
    const w = (await res.json()) as SettingsWire;
    return {
      text: normalizeStyle(w.textStyle),
      voice: normalizeStyle(w.voiceStyle),
      live: normalizeStyle(w.liveStyle),
    };
  } catch {
    return null;
  }
}

// Per-surface write generation: every putSettings bumps the counter for each surface it writes. Only the
// LATEST write for a surface is allowed to clear its pending flag, so a slow earlier PUT can't clear the
// flag a newer, still-unconfirmed pick just set.
const writeGen: Record<StyleSurface, number> = { text: 0, voice: 0, live: 0 };
// Serialize all writes through one chain so the server applies picks in the order they were made (a later
// pick can't be overtaken at the server by an earlier one arriving late). The chain never rejects.
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Persist one or more surface styles. Fire-and-forget, like syncProfile. Sends the literal style for each
 * surface (including "default", which resets that surface to null server-side). On success it clears the
 * surface's "pending" flag — but only if this write is still the latest for that surface — so a later load
 * lets the server win; on failure (or if superseded) the flag stays set, so the unsynced local value
 * survives a reload and gets re-pushed instead of being clobbered by stale server state.
 */
export function putSettings(partial: Partial<Record<StyleSurface, ResponseStyle>>): void {
  const surfaces = (Object.keys(partial) as StyleSurface[]).filter((s) => partial[s]);
  if (surfaces.length === 0) return;
  const body: Record<string, string> = {};
  const gen: Partial<Record<StyleSurface, number>> = {};
  for (const s of surfaces) { body[FIELD[s]] = partial[s]!; gen[s] = ++writeGen[s]; }
  writeChain = writeChain
    .catch(() => {}) // a failed prior write must not break the chain
    .then(() => api("/api/chat/settings", { method: "PUT", body: JSON.stringify(body) }))
    .then((res) => {
      if (res.ok) for (const s of surfaces) if (gen[s] === writeGen[s]) store.setStylePending(s, false);
    })
    .catch(() => {
      /* leave pending set — the value stays cached locally and re-syncs on the next load/pick */
    });
}
