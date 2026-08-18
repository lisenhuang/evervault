// When each message was said: the small time in the corner of a bubble, and the date separators that
// break the transcript into days.
//
// Days are the user's own calendar days, exactly as the history sidebar reckons them (see
// historyGroups.ts): "yesterday" is the day before today on the wall calendar, not 24 hours ago and not
// whatever UTC thinks. A message sent at 11pm is still yesterday's at 1am, and nothing here subtracts
// milliseconds to decide that.
//
// Formatting goes through Intl so the time reads the way the user's own locale writes it — 14:30 in
// Germany, 2:30 PM in the US — rather than a shape we picked.

import { localDateStr } from "./recurrence";

/** The calendar day a message belongs to, as a local YYYY-MM-DD key. Empty for an unusable timestamp. */
export function dayKey(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : localDateStr(d);
}

/**
 * Whether a date separator belongs between two messages.
 *
 * True at the very start of a conversation and at every change of day after it. A message with no
 * usable time never introduces a separator: a stray one would cut the transcript in half and claim a
 * date it doesn't know.
 */
export function needsDaySeparator(prevIso: string | undefined | null, iso: string | undefined | null): boolean {
  const day = dayKey(iso);
  if (!day) return false;
  return day !== dayKey(prevIso);
}

// Built formatters, kept by locale. A bubble formats its time on every render, and constructing an
// Intl.DateTimeFormat is the expensive part of doing so.
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The time formatter for a locale, padded the way that locale writes clock times: "09:05" where the day
 * runs to 24 hours, "9:05 AM" where it runs to 12. Padding a 12-hour time gives "09:05 AM", which no
 * one writes, and leaving a 24-hour one unpadded gives "9:05", which sits raggedly under "14:30".
 */
function timeFormatter(locale: string): Intl.DateTimeFormat {
  const cached = timeFormatters.get(locale);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    const twelveHour = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ?? false;
    fmt = new Intl.DateTimeFormat(locale, { hour: twelveHour ? "numeric" : "2-digit", minute: "2-digit" });
  } catch {
    // An unknown locale tag must not take the timestamp down with it.
    fmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  }
  timeFormatters.set(locale, fmt);
  return fmt;
}

/** The time shown in the corner of a bubble — hours and minutes, in the locale's own convention. */
export function formatMessageTime(iso: string | undefined | null, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return timeFormatter(locale).format(d);
}

/**
 * The label on a date separator: "Today", "Yesterday", then the date itself — with the year included
 * only once it differs from the current one, which is how a chat app avoids stamping "2026" on every
 * separator in a conversation held this week.
 */
export function formatDaySeparator(
  iso: string,
  locale: string,
  labels: { today: string; yesterday: string },
  now = new Date(),
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const day = localDateStr(d);
  if (day === localDateStr(now)) return labels.today;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === localDateStr(yesterday)) return labels.yesterday;

  const sameYear = d.getFullYear() === now.getFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYear
    ? { month: "long", day: "numeric" }
    : { year: "numeric", month: "long", day: "numeric" };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
}
