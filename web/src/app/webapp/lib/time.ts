// Time context for the AI: every chat turn tells the model the user's current local date/time so it
// can answer "what time is it" and resolve relative dates ("tomorrow", "last week"). Recalled memories
// are dated too, so the model also knows *when* past things were said.

/** One-line statement of the user's current local date/time + timezone, for the system instruction. */
export function currentTimeContext(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `The current date and time is ${now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })} (${tz}).`;
}

/** Short date label for a recalled memory, e.g. "Jun 15, 2026". */
export function formatMemoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
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
