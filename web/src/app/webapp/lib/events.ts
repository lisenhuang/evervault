// Dated things happening in the user's life — the "how did the interview go?" layer.
//
// The lifecycle here is the reverse of a task's, and that reversal is the whole point. A task waits for
// the user to DO something; an event happens to them whether or not they act, and the useful behaviour
// is for the assistant to notice the day passed and ask, once. So this store is allowed to be written
// by passive extraction (unlike tasks, where a to-do only exists after the human confirms it) —
// remembering that someone has an interview on Thursday creates no obligation for them, it just means
// they get asked about it on Friday.
//
// `followedUpAt` is what stops it asking twice, which is the difference between a friend and a bot.

import { api, postJsonBeacon } from "../authApi";
import { localDateStr } from "./recurrence";

export type LifeEvent = {
  id: number;
  title: string;
  details: string | null;
  eventDate: string | null; // "YYYY-MM-DD" civil date
  status: string; // "open" | "closed"
  followedUpAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EventDelta = {
  adds?: { title: string; details?: string; eventDate?: string }[];
  followedUp?: number[];
  closes?: number[];
};

export async function getEvents(status = "open"): Promise<LifeEvent[]> {
  try {
    const res = await api(`/api/chat/events?status=${encodeURIComponent(status)}`);
    if (res.ok) return (await res.json()) as LifeEvent[];
  } catch {
    /* ignore */
  }
  return [];
}

/** Apply an extraction delta. Fire-and-forget, like syncProfile. */
export function syncEvents(delta: EventDelta, conversationId: string): void {
  if (!delta.adds?.length && !delta.followedUp?.length && !delta.closes?.length) return;
  void postJsonBeacon("/api/chat/events/sync", { ...delta, conversationId }).catch(() => {});
}

export async function deleteEvent(id: number): Promise<void> {
  try {
    await api(`/api/chat/events/${id}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

export async function clearEvents(): Promise<void> {
  try {
    await api("/api/chat/events?all=true", { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

// --- Injection ---

/** How far ahead an event is worth mentioning. Beyond this it's not news yet. */
const UPCOMING_DAYS = 14;
/** How long after the day we still ask how it went. Past this, asking is odd rather than thoughtful. */
const FOLLOW_UP_DAYS = 10;
const UPCOMING_CAP = 5;
const FOLLOW_UP_CAP = 3;

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

function whenLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${-days} days ago`;
}

/**
 * Two short lists: what's coming up, and what has just happened that we haven't asked about yet.
 * Deterministic (no model call) and re-rendered every turn, so an event asked about mid-conversation
 * drops out of the next turn's block.
 */
export function renderEventsBlock(events: LifeEvent[], now = new Date()): string | null {
  const today = localDateStr(now);
  const open = events.filter((e) => e.status === "open" && e.eventDate);

  const upcoming: string[] = [];
  const justHappened: string[] = [];

  for (const e of open) {
    const days = daysBetween(today, e.eventDate!);
    if (days == null) continue;
    if (days >= 0 && days <= UPCOMING_DAYS) {
      upcoming.push(`- ${e.title} (${whenLabel(days)})`);
    } else if (days < 0 && days >= -FOLLOW_UP_DAYS && !e.followedUpAt) {
      // Only ever offered once: followedUpAt is set as soon as we ask.
      justHappened.push(`- ${e.title} (${whenLabel(days)})`);
    }
  }

  if (upcoming.length === 0 && justHappened.length === 0) return null;

  const parts: string[] = [];
  if (justHappened.length > 0) {
    parts.push(
      "Things in this user's life that have just happened and you haven't asked about yet. Ask about " +
      "ONE of these, naturally and early, the way a friend who remembered would — \"how did the " +
      "interview go?\" — then let them steer. Ask each of these only once, ever; if they'd rather not " +
      "talk about it, drop it and don't raise it again. Don't assume how it went, and don't congratulate " +
      "or commiserate before they've told you:\n" +
      justHappened.slice(0, FOLLOW_UP_CAP).join("\n"),
    );
  }
  if (upcoming.length > 0) {
    parts.push(
      "Coming up for this user. Only bring these up if it fits what they're already talking about, or " +
      "if it's today or tomorrow — don't recite the list:\n" + upcoming.slice(0, UPCOMING_CAP).join("\n"),
    );
  }
  return parts.join("\n\n");
}
