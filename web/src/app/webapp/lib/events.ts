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

/** Keep a detail to one useful phrase ("at 4pm at the children's hospital"), not a paragraph — the block
 *  is injected on every turn and several events could otherwise crowd out the conversation. */
function clipDetail(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
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
    // `details` carries whatever the user actually said — very often the time ("at 4pm"), which
    // eventDate cannot hold. Dropping it left the model with a bare "today" and no way to tell an
    // event that has already happened from one still hours away.
    const detail = (e.details ?? "").replace(/\s+/g, " ").trim();
    const line = `- ${e.title}${detail ? ` — ${clipDetail(detail)}` : ""}`;

    if (days >= 0 && days <= UPCOMING_DAYS) {
      upcoming.push(`${line} (${whenLabel(days)})`);
    } else if (days < 0 && days >= -FOLLOW_UP_DAYS && !e.followedUpAt) {
      // Only ever offered once: followedUpAt is set as soon as we ask.
      justHappened.push(`${line} (${whenLabel(days)})`);
    }
  }

  if (upcoming.length === 0 && justHappened.length === 0) return null;

  const parts: string[] = [];
  if (justHappened.length > 0) {
    parts.push(
      "Things in this user's life that have just happened and you haven't asked about yet. When the " +
      "conversation has room for it, ask about ONE of these, the way a friend who remembered would — " +
      "\"how did the interview go?\" — then let them steer. This NEVER comes ahead of what they " +
      "actually said: answer their message in full first and put the question at the end of that same " +
      "reply, or leave it for another turn if it would cut across what they came for. Never send a " +
      "reply that is only this question while their own message sits unanswered. Ask each of these " +
      "only once, ever; if they'd rather not talk about it, drop it and don't raise it again. Don't " +
      "assume how it went, and don't congratulate or commiserate before they've told you:\n" +
      justHappened.slice(0, FOLLOW_UP_CAP).join("\n"),
    );
  }
  if (upcoming.length > 0) {
    parts.push(
      "Coming up for this user. Only bring these up if it fits what they're already talking about, or " +
      "if it's today or tomorrow — and even then only after you've answered them, never as the reply " +
      "itself. Don't recite the list.\n" +
      // The reported failure: an IV drip the user had said was at 4pm was asked about at 3pm as "how did
      // it go?" — the model read the bare "today" as already past. These entries are dated, not timed,
      // so "today" genuinely does not say whether it has happened.
      "NOTHING HERE HAS HAPPENED YET as far as you know — this is the upcoming list, not the past one. " +
      "An entry marked today may still be hours away: you are given the day, and only sometimes the time. " +
      "So never ask how one of these went, never use the past tense about it, and never assume it is " +
      "done — not even late in the day. Speak about it as still ahead: \"good luck this afternoon\", " +
      "\"are you still heading in at four?\". If a line shows a time, respect it against the current time " +
      "you were given, and if that time has passed, still ASK whether it happened rather than assuming " +
      "it did — plans slip. Only once the user tells you it happened may you talk about it in the past:\n" +
      upcoming.slice(0, UPCOMING_CAP).join("\n"),
    );
  }
  return parts.join("\n\n");
}
