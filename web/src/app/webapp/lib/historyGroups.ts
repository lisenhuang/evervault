// Sorts the conversation list into the buckets the sidebar shows it in: Pinned, then Today, Yesterday,
// and widening spans back into the past.
//
// Kept apart from the component that renders it because the interesting part is calendar arithmetic, not
// markup. "Yesterday" means the day before today on the user's own wall calendar — not 24 hours ago, and
// not whatever UTC thinks. A conversation held at 11pm is still yesterday's at 1am, and in a timezone
// behind UTC a message sent this evening has already rolled into tomorrow by ISO reckoning. Both of those
// are why localDateStr exists (see recurrence.ts) and why nothing here subtracts milliseconds.

import { localDateStr } from "./recurrence";
import type { Conversation } from "../conversationsApi";

/** The buckets, in the order they are shown. `pinned` is not a span of time — it outranks all of them. */
export type BucketId = "pinned" | "today" | "yesterday" | "last7" | "last30" | "older";

const ORDER: BucketId[] = ["pinned", "today", "yesterday", "last7", "last30", "older"];

export type Bucket = { id: BucketId; conversations: Conversation[] };

/** Whole days between two local calendar dates, ignoring the time of day within them. */
function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Which bucket a conversation last spoken in at `iso` belongs to, relative to `now`.
 * An unparseable or future date reads as today: the list is sorted by this timestamp anyway, so a clock
 * skew of a few minutes shouldn't file this morning's chat under "older".
 */
export function bucketFor(iso: string, now = new Date()): Exclude<BucketId, "pinned"> {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "today";
  // Compare on the calendar, not the clock — see the note at the top of this file.
  if (localDateStr(at) === localDateStr(now)) return "today";
  const days = daysBetween(at, now);
  if (days < 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "last7";
  if (days <= 30) return "last30";
  return "older";
}

/**
 * Group conversations for display, preserving the order they arrive in (the server has already sorted
 * them pinned-first, then most recent). Empty buckets are dropped, so the sidebar never shows a heading
 * with nothing under it.
 */
export function groupConversations(conversations: Conversation[], now = new Date()): Bucket[] {
  const byBucket = new Map<BucketId, Conversation[]>();
  for (const c of conversations) {
    // A pinned conversation appears once, at the top, and not again under its date — being pinned is the
    // whole reason the user doesn't want to go looking for it by when it happened.
    const id: BucketId = c.pinned ? "pinned" : bucketFor(c.lastMessageAt, now);
    const group = byBucket.get(id);
    if (group) group.push(c);
    else byBucket.set(id, [c]);
  }
  return ORDER.filter((id) => byBucket.has(id)).map((id) => ({ id, conversations: byBucket.get(id)! }));
}
