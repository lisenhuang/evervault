// Time context for the AI: every turn tells the model the user's current local date/time so it can
// answer "what time is it" and resolve relative dates. Recalled memories are dated too.

/** One-line statement of the user's current local date/time + timezone, for the system instruction. */
export function currentTimeContext(): string {
  const now = new Date();
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    /* Intl timeZone unavailable on some engines */
  }
  const when = now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  return `The current date and time is ${when}${tz ? ` (${tz})` : ""}.`;
}

/** Short date label for a recalled memory, e.g. "Jun 15, 2026". */
export function formatMemoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** A duration in seconds as a call-style clock: `mm:ss`, rolling over to `h:mm:ss` past an hour. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${String(minutes).padStart(2, "0")}:${ss}`;
}
