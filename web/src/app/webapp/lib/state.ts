// "How have you been lately" memory — the layer that lets the assistant notice someone had a rough
// week and ask how it's going, instead of greeting them identically every time.
//
// Kept apart from profile facts on purpose. A fact is durable ("works at X"); this is explicitly
// PERISHABLE, and a stale one is worse than none — being asked about a bad week a month after it
// ended is the exact failure this must avoid. So states expire from injection after a fortnight, and
// the block below always tells the model how old each one is and to treat it as possibly out of date.
//
// Extracted in the browser like everything else here; the server only stores and serves.

import { api, postJsonBeacon } from "../authApi";
import { localDateStr } from "./recurrence";

export type UserState = {
  id: number;
  key: string; // short theme slug: "work", "health", "sleep", "mood"
  value: string; // one sentence, phrased as something the user said about themselves
  notedOn: string | null; // "YYYY-MM-DD" civil date they said it
  createdAt: string;
  updatedAt: string;
};

export type StateDelta = {
  upserts?: { key: string; value: string; notedOn?: string }[];
  removes?: string[]; // keys
};

export async function getStates(): Promise<UserState[]> {
  try {
    const res = await api("/api/chat/states");
    if (res.ok) return (await res.json()) as UserState[];
  } catch {
    /* ignore */
  }
  return [];
}

/** Apply an extraction delta. Fire-and-forget, like syncProfile. */
export function syncStates(delta: StateDelta): void {
  if (!delta.upserts?.length && !delta.removes?.length) return;
  void postJsonBeacon("/api/chat/states/sync", delta).catch(() => {});
}

export async function deleteState(id: number): Promise<void> {
  try {
    await api(`/api/chat/states/${id}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

export async function clearStates(): Promise<void> {
  try {
    await api("/api/chat/states?all=true", { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

// --- Injection ---

/** After this, a state stops being injected entirely. Two weeks is about how long "lately" means:
 * long enough to follow up on a hard week, short enough that it can't become a stale label. */
const MAX_AGE_DAYS = 14;
const DAY_MS = 86_400_000;

/** Whole days between two civil dates, or null if either is unusable. */
function daysAgo(dateStr: string | null, today: string): number | null {
  if (!dateStr) return null;
  const a = Date.parse(`${dateStr}T00:00:00`);
  const b = Date.parse(`${today}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

function ageLabel(days: number | null): string {
  if (days == null) return "recently";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "about a week ago";
  return "about two weeks ago";
}

/**
 * The "how they've been lately" block, or null when there's nothing recent. Every line carries its own
 * age so the model can't mistake a fortnight-old remark for today's mood, and the preamble sets the
 * rules for using it at all — this is the part of memory most capable of making someone feel watched
 * rather than known, so the framing matters more than the data.
 */
export function renderStateBlock(states: UserState[], now = new Date()): string | null {
  const today = localDateStr(now);
  const fresh = states.filter((s) => {
    // Fall back to updatedAt when the model gave no civil date, so an undated row still expires.
    const days = daysAgo(s.notedOn ?? (s.updatedAt ?? "").slice(0, 10), today);
    return days == null || days <= MAX_AGE_DAYS;
  });
  if (fresh.length === 0) return null;

  const lines = fresh.map((s) => {
    const days = daysAgo(s.notedOn ?? (s.updatedAt ?? "").slice(0, 10), today);
    return `- ${s.value} (${ageLabel(days)})`;
  });

  return (
    "How this user has been lately, in their own words. This is NOT current fact — it is what they " +
    "said at the time, and things change. Use it the way a friend would: it may prompt you to ask how " +
    "something turned out, or to be a bit gentler, and that's all. Do NOT open with it, do not bring " +
    "up more than one of these in a conversation, and never treat something from over a week ago as " +
    "how they feel right now — ask, don't assume. Never diagnose, label, or infer any medical or " +
    "mental-health condition from it, and never imply you have been monitoring their mood. If they " +
    "don't want to get into it, drop it immediately and don't return to it:\n" +
    lines.join("\n")
  );
}
