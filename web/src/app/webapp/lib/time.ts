// Time context for the AI: every chat turn tells the model the user's current local date/time so it
// can answer "what time is it" and resolve relative dates ("tomorrow", "last week"). Recalled memories
// are dated too, so the model also knows *when* past things were said.

import { localDateStr } from "./recurrence";

/** Local ISO 8601 timestamp *with* numeric offset, e.g. "2026-07-08T06:50:00+12:00". Unlike
 * `Date#toISOString()` (always UTC "Z"), this keeps the user's wall-clock time and offset so the model
 * can compute correct date ranges ("yesterday 00:00") for memory recall without guessing the offset. */
function localIso(now: Date): string {
  const offMin = -now.getTimezoneOffset(); // getTimezoneOffset is inverted (UTC−local)
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** One-line statement of the user's current local date/time + timezone, for the system instruction.
 * Includes a machine-readable ISO 8601 timestamp (with offset) so the model can accurately derive
 * date ranges for date-scoped memory recall ("yesterday", "last week") instead of guessing the offset
 * from the timezone name alone. */
export function currentTimeContext(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const human = now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  return `The current date and time is ${human} (${tz}). In ISO 8601: ${localIso(now)}.`;
}

/** Short date label for a recalled memory, e.g. "Jun 15, 2026". */
export function formatMemoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** A stored item's timestamp as a human label in the user's LOCAL time, relative for recent days so the
 * model narrates recency correctly: "today at 11:30 AM", "yesterday at 8:10 PM", else
 * "Jul 15, 2026 at 8:10 PM". The raw ISO is UTC (DateTimeOffset.UtcNow, "…+00:00"); handing that
 * straight to the model made it read the UTC date and say "yesterday" for a file sent today — for users
 * east of UTC (e.g. NZ +12/13) a morning-local instant rolls back a calendar day in UTC. Day
 * classification is pure wall-calendar (localDateStr), never now−24h, so it stays correct across DST. */
export function formatLocalWhen(iso: string): string {
  const d = new Date(iso); // respects the browser's local zone
  const now = new Date();
  const day = localDateStr(d);
  const nowDay = localDateStr(now);
  const yestDay = localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (day === nowDay) return `today at ${time}`;
  if (day === yestDay) return `yesterday at ${time}`;
  return `${formatMemoryDate(iso)} at ${time}`;
}

/**
 * A duration in seconds as a call-style clock: `mm:ss` (e.g. "02:34"), rolling over to `h:mm:ss`
 * past an hour. Used for the live call timer and the call-ended summary in chat history.
 */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${String(minutes).padStart(2, "0")}:${ss}`;
}
