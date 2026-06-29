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
