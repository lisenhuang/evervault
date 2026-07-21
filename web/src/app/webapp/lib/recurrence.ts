// Repeat rules for tasks — the "remind me every weekend" engine.
//
// Everything here is CIVIL-CALENDAR math: dates are plain "YYYY-MM-DD" wall-calendar days, never
// instants. That is deliberate and matches UserTask.DueDate — "Saturday" must mean Saturday wherever
// the user happens to be, so no UTC offset, DST shift or air travel can move a chore to the wrong day.
// The browser is the only party that reliably knows the user's wall calendar (the server's stored
// timezone is written once at sign-in and may be absent), so the browser owns all of this; the server
// only validates the token's shape and stores it.
//
// A repeating task is ONE row whose due date keeps moving forward — never a stream of instance rows.
// That keeps it on the agenda for free, costs one line of prompt, and can't trip the /sync duplicate
// guard. Missed occurrences are dropped rather than accrued: three skipped weekends produce one clean
// "due today", not five overdue copies of the same chore.

/** Local "YYYY-MM-DD" for the given date. Built by hand rather than via toISOString(), which would
 * shift into UTC and land on the wrong day near midnight for non-UTC users. Lives here (rather than in
 * ./tasks, which re-exports it) so this module has no dependencies and the two can't form a cycle. */
export function localDateStr(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Sunday-first, matching JavaScript's `Date#getDay()`. */
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

type Rule =
  | { kind: "daily" }
  | { kind: "weekly"; days: number[] } // 0 = Sunday … 6 = Saturday
  | { kind: "monthly"; day: number }; // 1–31, clamped to each month's length

/**
 * Parse a stored rule token. Returns null for anything unrecognised — callers then treat the task as
 * a plain one-off, which is the safe degradation for a model-generated value.
 *
 * `weekdays` and `weekends` are kept as their own tokens rather than being written out as
 * `weekly:mon,tue,…` so that `describeRecurrence` can say "every weekend" instead of listing five days.
 */
export function parseRecurrence(rule: string | null | undefined): Rule | null {
  const s = (rule ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "daily") return { kind: "daily" };
  if (s === "weekdays") return { kind: "weekly", days: [1, 2, 3, 4, 5] };
  // "Every weekend" means ONCE a weekend, not once on each of the two days — so it anchors on
  // Saturday rather than expanding to [Sat, Sun]. Expanding would re-raise a chore on Sunday the
  // moment the user finished it on Saturday. Someone who genuinely wants both days says "every
  // Saturday and Sunday", which is `weekly:sat,sun`. The Sunday half of the window still works:
  // an occurrence missed on Saturday stays visible until the next one is due (see rollForward).
  if (s === "weekends") return { kind: "weekly", days: [6] };
  if (s.startsWith("weekly:")) {
    const days = s
      .slice(7)
      .split(",")
      .map((d) => DOW.indexOf(d.trim() as (typeof DOW)[number]))
      .filter((i) => i >= 0);
    return days.length ? { kind: "weekly", days: [...new Set(days)].sort() } : null;
  }
  if (s.startsWith("monthly:")) {
    const day = Number(s.slice(8));
    return Number.isInteger(day) && day >= 1 && day <= 31 ? { kind: "monthly", day } : null;
  }
  return null;
}

/** True when the string is a rule this build understands. */
export const isRecurring = (rule: string | null | undefined): boolean => parseRecurrence(rule) !== null;

// --- civil date helpers -------------------------------------------------------------------------

/** Parse "YYYY-MM-DD" into a local Date pinned to NOON. Noon (not midnight) because a handful of
 * zones skip midnight itself on DST-transition days, where `new Date(y, m, d)` would silently land on
 * the previous day. Noon is safely inside every real-world offset shift. */
function toCivil(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
}

const addDays = (d: Date, n: number): Date => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};

/** Days in a given month, so `monthly:31` becomes the 28th/29th/30th where that month is shorter. */
const daysInMonth = (year: number, monthIndex: number): number => new Date(year, monthIndex + 1, 0).getDate();

// --- the engine ---------------------------------------------------------------------------------

/** The first occurrence STRICTLY AFTER `from` ("YYYY-MM-DD"), or null if the rule is unusable. */
export function nextOccurrence(rule: string | null | undefined, from: string): string | null {
  const r = parseRecurrence(rule);
  const start = toCivil(from);
  if (!r || !start) return null;

  if (r.kind === "daily") return localDateStr(addDays(start, 1));

  if (r.kind === "weekly") {
    // At most 7 steps: some day of the coming week always matches a non-empty day set.
    for (let i = 1; i <= 7; i++) {
      const d = addDays(start, i);
      if (r.days.includes(d.getDay())) return localDateStr(d);
    }
    return null;
  }

  // Monthly: always derive the target from the RULE, never from the current date — otherwise a run
  // clamped to Feb 28 would stay on the 28th forever instead of returning to the 31st in March.
  let year = start.getFullYear();
  let month = start.getMonth();
  const dayThisMonth = Math.min(r.day, daysInMonth(year, month));
  if (start.getDate() >= dayThisMonth) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  const day = Math.min(r.day, daysInMonth(year, month));
  return localDateStr(new Date(year, month, day, 12, 0, 0, 0));
}

/**
 * Advance a repeating task's due date to the first occurrence **on or after** `today`, so a chore
 * missed for three weeks shows up once as "due today" rather than as three overdue rows. Returns null
 * when nothing needs to change (already current, not repeating, or unusable rule).
 *
 * Every rule in this grammar is ANCHOR-INDEPENDENT — the occurrences of `weekends` are all Saturdays
 * and Sundays, of `daily` every day, of `monthly:15` the 15th of every month — none of which depend on
 * where the series started. So the answer is simply the first occurrence on or after today, computed
 * directly rather than by stepping. That also means a task abandoned for a decade costs the same as
 * one missed by a day; an earlier stepping version silently gave up on those and left them stuck
 * overdue forever. If an interval-style rule (say `every:3d`) is ever added it will NOT be
 * anchor-independent, and this shortcut has to grow a stepping path for that case.
 */
export function rollForward(
  rule: string | null | undefined,
  dueDate: string | null | undefined,
  today = localDateStr(),
): string | null {
  if (!isRecurring(rule)) return null;
  // No seed date (the model set a repeat but no first date): anchor the series starting from today.
  if (!dueDate) return firstOccurrence(rule, today);
  if (dueDate >= today) return null; // still in the future — leave it alone

  // A missed occurrence is NOT collapsed straight away. It stays on the list as overdue until a newer
  // occurrence has actually come due — which is what gives "every weekend" its Sunday: the Saturday
  // task is still there, still outstanding, right through until the next Saturday arrives. Only then
  // does it fold onto the current occurrence, so the user sees one live chore instead of a pile.
  const superseding = nextOccurrence(rule, dueDate);
  if (!superseding || superseding > today) return null;
  return firstOccurrence(rule, today);
}

/** The first occurrence on or after `from` — today itself counts when it matches the rule. Used to
 * anchor a brand-new repeating task so "every weekend", created on a Saturday, is due that same day. */
export function firstOccurrence(rule: string | null | undefined, from = localDateStr()): string | null {
  const r = parseRecurrence(rule);
  if (!r) return null;
  const d = toCivil(from);
  if (!d) return null;
  if (r.kind === "daily") return from;
  if (r.kind === "weekly" && r.days.includes(d.getDay())) return from;
  if (r.kind === "monthly" && d.getDate() === Math.min(r.day, daysInMonth(d.getFullYear(), d.getMonth()))) return from;
  return nextOccurrence(rule, from);
}

const DOW_LABEL: Record<number, string> = {
  0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday",
};

const ORDINAL = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};

/**
 * A short human phrase for the rule, e.g. "every weekend". Rendered into the agenda block so the
 * model can say what the schedule is without having to decode the token itself (and without being
 * tempted to read the raw token aloud, which would leak an internal format).
 */
export function describeRecurrence(rule: string | null | undefined): string {
  const s = (rule ?? "").trim().toLowerCase();
  if (s === "daily") return "every day";
  if (s === "weekdays") return "every weekday";
  if (s === "weekends") return "every weekend";
  const r = parseRecurrence(s);
  if (!r) return "";
  if (r.kind === "weekly") {
    const names = r.days.map((d) => DOW_LABEL[d]);
    if (names.length === 1) return `every ${names[0]}`;
    return `every ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  if (r.kind === "monthly") return `on the ${ORDINAL(r.day)} of each month`;
  return "";
}
